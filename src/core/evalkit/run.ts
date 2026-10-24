import { METHOD_IDS, SCORED_METHODS, classifyMethod, findingFor, reclassify } from '../methods/index.ts';
import { needsJudge } from '../policy/decide.ts';
import { loadThresholds } from '../policy/thresholds.ts';
import { buildLlmOnlyView, buildMaskedView } from '../judge/views.ts';
import { addUsage, failedResult, isReasonCode, ZERO_USAGE } from '../judge/contract.ts';
import type { JudgeResult, JudgeUsage, MaskedView } from '../judge/contract.ts';
import type { DescribedJudge } from '../providers/types.ts';
import { LeakGuardError, serializeSafe } from '../safe.ts';
import { sha256Hex, stableStringify } from '../judge/fingerprint.ts';
import { createCacheIdentity } from './cache.ts';
import { bootstrapReduction, makeBootstrapPlan, pairedMatchedReductionDifference, validateBootstrapPlan } from './bootstrap.ts';
import { computeMetrics } from './metrics.ts';
import { matchedRecall } from './matched.ts';
import { scoreSweep, thresholdsAt } from './sweep.ts';
import { validateSamples } from './split.ts';
import type { EvaluationResult, MethodId, MethodResult, Observation, PairedComparison, RunEvaluationInput, Sample } from './types.ts';

function descriptorFor(method: MethodId, input: RunEvaluationInput): DescribedJudge | undefined {
  return method === 'jev' ? input.judges.jev : method === 'llm-only' ? input.judges.llmOnly ?? input.judges.generative : input.judges.generative;
}
function validUsage(usage: unknown): usage is JudgeUsage {
  if (!usage || typeof usage !== 'object') return false;
  const fields = usage as Record<string, unknown>;
  return ['calls', 'inputTokens', 'outputTokens'].every(key => Number.isSafeInteger(fields[key]) && (fields[key] as number) >= 0)
    && typeof fields.usd === 'number' && Number.isFinite(fields.usd) && fields.usd >= 0;
}
function validResult(result: JudgeResult, view: MaskedView, judge: DescribedJudge): boolean {
  if (!result || typeof result !== 'object') return false;
  if (result.provider !== judge.descriptor.provider || result.modelId !== judge.descriptor.modelId) return false;
  if (!['ok', 'failed', 'not_requested'].includes(result.status) || !validUsage(result.usage)) return false;
  if (result.status !== 'ok') return true;
  if (!Number.isFinite(result.p_real) || result.p_real < 0 || result.p_real > 1 || !isReasonCode(result.reason_code)) return false;
  if (judge.descriptor.citationsRequired && (!result.cited_lines || !result.cited_lines.length)) return false;
  if (result.cited_lines && (!Array.isArray(result.cited_lines) || result.cited_lines.length > 7 || result.cited_lines.some((id) => !view.maskedWindow.some((line) => line.lineId === id)))) return false;
  return typeof result.model_text === 'undefined' || (typeof result.model_text === 'string' && result.model_text.length <= 200 && result.model_text_label === 'model-authored');
}

function usageReceipt(value: unknown): JudgeUsage | undefined {
  if (!validUsage(value)) return undefined;
  return { calls: value.calls, inputTokens: value.inputTokens, outputTokens: value.outputTokens, usd: value.usd };
}
async function observe(method: MethodId, sample: Sample, input: RunEvaluationInput, configVersion: string): Promise<Observation> {
  const deterministic: Observation = { sampleKey: sample.key, band: 'review', source: 'deterministic', origin: 'deterministic' };
  let base: Observation = { ...deterministic };
  let activeJudge: DescribedJudge | undefined;
  let dispatched = false;
  const finding = findingFor(method, sample);
  if (!finding) return deterministic;
  try {
    // These are pure in-process classifications, not outbound Finding payloads. Guard only actual judge views/writes.
    if (!SCORED_METHODS.includes(method) || (method !== 'llm-only' && !needsJudge(finding))) {
      return { ...deterministic, band: classifyMethod(method, sample, undefined, input.thresholds, input.highPrecisionRules) };
    }
    const judge = descriptorFor(method, input);
    if (!judge) return deterministic;
    activeJudge = judge;
    const origin = judge.descriptor.kind === 'scripted-mock' ? 'scripted-mock' : 'live';
    base = { ...deterministic, source: origin, origin };
    const built = method === 'llm-only' ? buildLlmOnlyView(finding) : buildMaskedView(finding);
    if (!built) return { ...base, judge: failedResult(judge.descriptor.provider, judge.descriptor.modelId, 'oversize_view') };
    const view = { ...built, findingId: sample.key };
    const identity = await createCacheIdentity(view, judge.descriptor, configVersion, input.guard);
    const cached = await input.cache?.get(identity, input.guard);
    let result: JudgeResult;
    if (cached) {
      if (cached.origin !== origin || !validResult(cached.result, view, judge)) throw new Error('');
      result = cached.result;
      base.source = 'replay';
      if (origin === 'live' && cached.measuredLatencyMs !== null) base.cachedLatencyMs = cached.measuredLatencyMs;
    } else {
      serializeSafe(view, 'judge_request', input.guard);
      const before = origin === 'live' ? globalThis.performance.now() : null;
      if (origin === 'live') { dispatched = true; base.attemptUsage = null; }
      try { result = await judge.judge(view); }
      finally {
        if (before !== null) {
          const elapsed = globalThis.performance.now() - before;
          if (Number.isFinite(elapsed) && elapsed >= 0) base.measuredLatencyMs = elapsed;
        }
      }
      // Copy only validated numeric fields BEFORE any response/cache guard can reject optional model material.
      if (dispatched) base.attemptUsage = result?.usage_unknown ? null : usageReceipt(result?.usage) ?? null;
      if (dispatched && base.attemptUsage === null) return { ...base, band: 'review' }; // Unknown receipt is never zero usage.
      if (!validResult(result, view, judge)) {
        result = failedResult(judge.descriptor.provider, judge.descriptor.modelId, 'invalid_output', usageReceipt(result?.usage) ?? ZERO_USAGE);
      }
      if (origin === 'scripted-mock' && Object.values(result.usage).some((n) => n !== 0)) throw new Error('');
      serializeSafe(result, 'cache', input.guard);
      if (result.status === 'ok' && input.cache) await input.cache.put({ identity, result, source: origin, origin,
        measuredLatencyMs: base.measuredLatencyMs ?? null, createdAt: new Date().toISOString() }, input.guard);
    }
    return { ...base, judge: result, band: classifyMethod(method, sample, result, input.thresholds, input.highPrecisionRules) };
  } catch (error) {
    // Adapter errors may carry a numeric attempt receipt. Never copy diagnostic text or other Error fields.
    if (dispatched && base.attemptUsage === null) {
      try { base.attemptUsage = usageReceipt((error as { usage?: unknown } | null)?.usage) ?? null; } catch { /* unknown receipt */ }
    }
    const receipt = base.attemptUsage;
    return { ...base, band: 'review', guardBlocked: error instanceof LeakGuardError,
      ...(activeJudge && receipt ? { judge: failedResult(activeJudge.descriptor.provider, activeJudge.descriptor.modelId,
        error instanceof LeakGuardError ? 'leak_guard' : 'provider_error', receipt) } : {}) };
  }
}

function notRun(method: MethodId, reason: string, configVersion: string, judge?: DescribedJudge): MethodResult {
  return { method, judge: judge ? { ...judge.descriptor } : null, configVersion, status: 'not-run', reason, observations: [], metrics: null, reductionInterval: null, curve: [], matched: [], usage: null, measuredLatencyMs: null, cachedLatencyMs: null };
}

export async function runEvaluation(input: RunEvaluationInput): Promise<EvaluationResult> {
  validateSamples(input.samples);
  if (new Set(input.samples.map((s) => s.split)).size > 1) throw new Error('One split per evaluation run.');
  const thresholds = loadThresholds(input.thresholds);
  const target = input.targetRecall ?? .98;
  if (!Number.isFinite(target) || target <= 0 || target > 1) throw new Error('Invalid recall target.');
  const plan = input.bootstrap ?? makeBootstrapPlan(input.samples.map((s) => s.group), 26, 2000);
  validateBootstrapPlan(plan, input.samples.map((s) => s.group));
  const configVersion = input.configVersion ?? await sha256Hex(stableStringify({ thresholds, highPrecisionRules: input.highPrecisionRules }));
  const methods: MethodResult[] = [];
  for (const method of METHOD_IDS) {
    const judge = descriptorFor(method, input);
    if (SCORED_METHODS.includes(method) && !judge) { methods.push(notRun(method, 'No judge configured; no mock substitution.', configVersion)); continue; }
    if (method === 'matchline' && input.samples.some((s) => !s.matchLineFinding)) { methods.push(notRun(method, 'Paired no-folder pipeline findings are unavailable.', configVersion, judge)); continue; }
    const observations: Observation[] = [];
    for (const sample of input.samples) observations.push(await observe(method, sample, { ...input, thresholds }, configVersion));
    const isMock = SCORED_METHODS.includes(method) && judge?.descriptor.kind === 'scripted-mock';
    const curve = scoreSweep(method, input.samples, observations, thresholds, input.highPrecisionRules);
    let usage = { ...ZERO_USAGE };
    let accountingKnown = true;
    for (const observation of observations) if (observation.source === 'live') {
      if (observation.attemptUsage === null) accountingKnown = false;
      else if (observation.attemptUsage) usage = addUsage(usage, observation.attemptUsage);
    }
    const freshLatencies = observations.flatMap((o) => o.measuredLatencyMs === undefined ? [] : [o.measuredLatencyMs]);
    const replayLatencies = observations.flatMap((o) => o.cachedLatencyMs === undefined ? [] : [o.cachedLatencyMs]);
    methods.push({
      method, judge: SCORED_METHODS.includes(method) && judge ? { ...judge.descriptor } : null, configVersion, status: isMock ? 'interface-replay' : 'computed',
      reason: isMock ? 'Scripted mock interface replay; model performance, cost and latency not measured.' : method === 'unsafe-path-dismiss' ? 'Unsafe eval-only ablation; not deployed policy.' : undefined,
      observations, metrics: computeMetrics(input.samples, observations), reductionInterval: bootstrapReduction(input.samples, observations, plan), curve,
      matched: [...new Set([.95, target, .99])].map((r) => matchedRecall(curve, r)),
      usage: isMock || !accountingKnown ? null : usage,
      measuredLatencyMs: !isMock && freshLatencies.length ? freshLatencies.reduce((a, b) => a + b, 0) : null,
      cachedLatencyMs: !isMock && replayLatencies.length ? replayLatencies.reduce((a, b) => a + b, 0) : null,
    });
  }
  const paired: PairedComparison[] = [];
  const jev = methods.find((m) => m.method === 'jev') as MethodResult;
  for (const rightId of ['deterministic', 'generative'] as const) {
    const right = methods.find((m) => m.method === rightId) as MethodResult;
    const a = matchedRecall(jev.curve, target), b = matchedRecall(right.curve, target);
    if (jev.status === 'not-run' || right.status === 'not-run' || !a.point || !b.point) {
      paired.push({ left: 'jev', right: rightId, targetRecall: target, attainable: false, difference: null, bootstrap: null }); continue;
    }
    const curveRows = (method: MethodId, result: MethodResult) => result.curve.map((point) => reclassify(method, input.samples, result.observations, thresholdsAt(thresholds, point.dismissThreshold), input.highPrecisionRules));
    paired.push({ left: 'jev', right: rightId, targetRecall: target, attainable: true, difference: (a.point.metrics.reduction as number) - (b.point.metrics.reduction as number), bootstrap: pairedMatchedReductionDifference(input.samples, curveRows('jev', jev), curveRows(rightId, right), plan, target) });
  }
  const generative = methods.find((m) => m.method === 'generative') as MethodResult;
  const live = (method: MethodResult) => method.status === 'computed' && method.observations.some((o) => o.origin === 'live' && o.judge?.status === 'ok') && !method.observations.some((o) => o.origin === 'scripted-mock');
  const eligible = target === .98 && input.samples.length > 0 && input.samples.every((s) => s.split === 'heldout') && live(jev) && live(generative) && paired.every((p) => p.attainable);
  const promoted = eligible && paired.every((p) => p.bootstrap?.interval !== null && p.bootstrap?.interval !== undefined && p.bootstrap.interval.low > 0);
  return {
    version: 1, targetRecall: target, bootstrap: { seed: plan.seed, replicates: plan.draws.length }, methods, paired,
    promotion: { eligible, promoted, equivalenceEnabled: false, reasons: promoted ? ['Live held-out matched-recall reduction is superior to both comparators at preregistered R=0.98.'] : ['Promotion requires live held-out Jev and generative rows, attainable preregistered R=0.98, and positive paired intervals against both comparators; cost-only/equivalence promotion is disabled.'] },
  };
}
