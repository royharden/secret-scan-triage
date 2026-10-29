// Evaluation methods only. The unsafe ablation is never imported by deployed policy/worker/UI.
import type { Band, Finding } from '../finding.ts';
import type { JudgeResult } from '../judge/contract.ts';
import { decide } from '../policy/decide.ts';
import type { Thresholds } from '../policy/thresholds.ts';
import type { MethodId, Observation, Sample } from '../evalkit/types.ts';

export const METHOD_IDS: readonly MethodId[] = ['scanner', 'allowlist', 'deterministic', 'llm-only', 'generative', 'jev', 'unsafe-path-dismiss', 'matchline'];
export const SCORED_METHODS: readonly MethodId[] = ['llm-only', 'generative', 'jev', 'matchline'];

export function findingFor(method: MethodId, sample: Sample): Finding | undefined {
  return method === 'matchline' ? sample.matchLineFinding : sample.finding;
}
export function llmOnlyBand(judge: JudgeResult | undefined, thresholds: Thresholds): Band {
  if (!judge || judge.status !== 'ok' || judge.reason_code === 'cannot_tell' || !Number.isFinite(judge.p_real) || judge.p_real < 0 || judge.p_real > 1) return 'review';
  if (thresholds.judge_dismiss_enabled && !thresholds.infeasible && judge.p_real <= thresholds.t_dismiss) return 'dismiss';
  return judge.p_real >= thresholds.t_keep ? 'keep' : 'review';
}
export function classifyMethod(method: MethodId, sample: Sample, judge: JudgeResult | undefined, thresholds: Thresholds, highPrecisionRules: readonly string[]): Band {
  const f = findingFor(method, sample);
  if (!f) return 'review';
  if (method === 'scanner') return 'review';
  if (method === 'allowlist') return sample.emulation.stopword || sample.emulation.allowedPath || sample.emulation.lowEntropy ? 'dismiss' : 'review';
  if (method === 'llm-only') return llmOnlyBand(judge, thresholds);
  if (method === 'unsafe-path-dismiss' && ['test', 'fixture', 'docs'].includes(f.features.pathClass)) return 'dismiss';
  return decide(f, method === 'deterministic' || method === 'unsafe-path-dismiss' ? null : judge ?? null, thresholds, highPrecisionRules).band;
}
export function reclassify(method: MethodId, samples: readonly Sample[], observations: readonly Observation[], thresholds: Thresholds, highPrecisionRules: readonly string[]): Observation[] {
  const byKey = new Map(observations.map((o) => [o.sampleKey, o]));
  return samples.map((sample) => {
    const previous = byKey.get(sample.key);
    return {
      ...(previous ?? { sampleKey: sample.key, source: 'deterministic' as const, origin: 'deterministic' as const }),
      band: previous?.guardBlocked ? 'review' : classifyMethod(method, sample, previous?.judge, thresholds, highPrecisionRules),
    };
  });
}
