import type { EvaluationResult, Interval, Metrics, Sample } from '../src/core/evalkit/types.ts';
import type { Thresholds } from '../src/core/policy/thresholds.ts';
import type { ThresholdLineage } from './study.ts';
export interface ReportBundle {
  dataset: { name: string; seed: number; generatorVersion: string; frozenAt: string | null; dev: { n: number; real: number }; heldout: { n: number; real: number } };
  mode: 'scripted-mock' | 'live';
  generatedAt: string;
  scoring: EvaluationResult;
  operating: { studyHash: string | null; operatingHash: string; configVersion: string; thresholds: Thresholds;
    thresholdHash: string; tuning: ThresholdLineage | null;
    disposition: 'primary-live' | 'exploratory-live' | 'interface-replay' | 'not-run' };
  breakdowns?: Array<{ kind: 'trap' | 'rule'; name: string; method: string; metrics: Metrics }>;
}
const number = (value: number | null) => value === null || !Number.isFinite(value) ? 'N/A' : value.toFixed(4);
const percent = (value: number | null) => value === null || !Number.isFinite(value) ? 'N/A' : `${(value * 100).toFixed(2)}%`;
const interval = (value: Interval | null | undefined) => value ? `${percent(value.low)}–${percent(value.high)}` : 'N/A';
const text = (value: string) => value.replace(/[\\|`<>\r\n]/g, char => char === '\n' || char === '\r' ? ' ' : `\\${char}`);
export function claim(bundle: ReportBundle): string {
  if (bundle.operating.disposition === 'exploratory-live') return 'Exploratory live repeat. Its results are descriptive; no primary held-out claim or preregistered promotion is available.';
  if (bundle.operating.disposition === 'not-run') return 'Live models not run: no live judge was configured. No dev tuning or primary held-out measurement is certified.';
  const row = bundle.scoring.methods.find(method => method.method === 'generative');
  if (bundle.mode !== 'live' || bundle.operating.disposition !== 'primary-live' || !bundle.operating.tuning
    || !bundle.dataset.frozenAt || row?.status !== 'computed' || !row.metrics || row.metrics.recall === null) {
    return 'Not yet measured. Scripted-mock output is interface replay, not model performance. No real-world generalisation is established.';
  }
  const m = row.metrics;
  return `On ${bundle.dataset.name} (${m.n} held-out candidates, ${m.real} labelled real), candidate recall was ${percent(m.recall)} (Wilson 95% ${interval(m.recallInterval)}) and false-positive reduction was ${percent(m.reduction)} (cluster-bootstrap 95% ${interval(row.reductionInterval?.interval)}). ${m.recall! < bundle.scoring.targetRecall ? 'Recall MISSED' : 'Recall met'} the predeclared ${percent(bundle.scoring.targetRecall)} target. Synthetic traps do not establish real-world generalisation.`;
}
export function resultsMarkdown(bundle: ReportBundle): string {
  const lines = ['# Automated evaluation', '', claim(bundle), '',
    `Dataset: ${bundle.dataset.name}; seed ${bundle.dataset.seed}; generator ${bundle.dataset.generatorVersion}; frozen ${bundle.dataset.frozenAt ?? 'NO (exploratory interface replay)'}.`,
    `Dev: N=${bundle.dataset.dev.n}, real=${bundle.dataset.dev.real}; held-out: N=${bundle.dataset.heldout.n}, real=${bundle.dataset.heldout.real}.`,
    `Mode: ${bundle.mode}. Bootstrap: ${bundle.scoring.bootstrap.replicates} group replicates, seed ${bundle.scoring.bootstrap.seed}. No human ruling or audit label enters these metrics.`, '',
    `Operating point: ${bundle.operating.disposition}; thresholds ${bundle.operating.thresholds.source} (dismiss ${bundle.operating.thresholds.t_dismiss}, keep ${bundle.operating.thresholds.t_keep}, dismissal enabled ${bundle.operating.thresholds.judge_dismiss_enabled}, infeasible ${!!bundle.operating.thresholds.infeasible}).`,
    `Study hash: ${bundle.operating.studyHash ?? 'not frozen'}; operating hash: ${bundle.operating.operatingHash}; configuration: ${bundle.operating.configVersion}; threshold hash: ${bundle.operating.thresholdHash}.`,
    `Dev tuning: ${bundle.operating.tuning ? `live; N=${bundle.operating.tuning.devCount}, real=${bundle.operating.tuning.devReal}; dev-population ${bundle.operating.tuning.devPopulationHash}` : 'not certified; no primary live claim'}.`, '',
    '| Method | Status | Judge kind; provider / model / adapter | Guard-blocked / candidates | Recall / Wilson95 | FP reduction / bootstrap95 | Review rate | Keep precision | Calls | Tokens | USD/1,000 | Fresh ms | Cached ms |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const row of bundle.scoring.methods) {
    const m = row.metrics;
    const name = row.method === 'allowlist' ? 'gitleaks-style allowlist emulation (unwrapped)' : row.method === 'llm-only' ? 'llm-only (masked-view guard)' : row.method;
    const judge = row.judge ? `${row.judge.kind}; ${row.judge.provider} / ${row.judge.modelId} / ${row.judge.id}`
      : ['generative', 'jev', 'llm-only', 'matchline'].includes(row.method) ? 'not configured' : 'not applicable';
    const blocked = row.status === 'not-run' ? 'N/A' : `${row.observations.filter(o => o.guardBlocked).length} / ${row.observations.length}`;
    lines.push(`| ${text(name)} | ${row.status}${row.reason ? `: ${text(row.reason)}` : ''} | ${text(judge)} | ${blocked} | ${percent(m?.recall ?? null)} / ${interval(m?.recallInterval)} | ${percent(m?.reduction ?? null)} / ${interval(row.reductionInterval?.interval)} | ${percent(m?.reviewRate ?? null)} | ${percent(m?.keepPrecision ?? null)} | ${row.usage?.calls ?? 'N/A'} | ${row.usage ? row.usage.inputTokens + row.usage.outputTokens : 'N/A'} | ${number(row.usage && m?.n ? row.usage.usd * 1000 / m.n : null)} | ${number(row.measuredLatencyMs)} | ${number(row.cachedLatencyMs)} |`);
  }
  if (bundle.breakdowns?.length) {
    lines.push('', '## Trap and rule strata', '', '| Kind | Name | Method | N / real / negative | Recall | FP reduction |', '|---|---|---|---|---|---|');
    for (const part of bundle.breakdowns) lines.push(`| ${part.kind} | ${text(part.name)} | ${part.method} | ${part.metrics.n} / ${part.metrics.real} / ${part.metrics.negative} | ${percent(part.metrics.recall)} | ${percent(part.metrics.reduction)} |`);
  }
  lines.push('', '## Matched recall (descriptive held-out curves)', '', '| Method | Target | Attainable | Reduction |', '|---|---|---|---|');
  for (const row of bundle.scoring.methods) for (const point of row.matched) lines.push(`| ${row.method} | ${percent(point.targetRecall)} | ${point.attainable ? 'yes' : 'no'} | ${percent(point.point?.metrics.reduction ?? null)} |`);
  lines.push('', '## Paired differences', '', '| Left − right | Target | Difference / 95% interval | Defined / excluded |', '|---|---|---|---|');
  for (const pair of bundle.scoring.paired) lines.push(`| ${pair.left} − ${pair.right} | ${percent(pair.targetRecall)} | ${pair.attainable ? `${percent(pair.difference)} / ${interval(pair.bootstrap?.interval)}` : 'unattainable; no comparison'} | ${pair.bootstrap?.valid ?? 0} / ${pair.bootstrap?.undefined ?? 0} |`);
  lines.push('', `Jev promotion: ${bundle.scoring.promotion.promoted ? 'earned' : 'not earned'}. Equivalence/cost-only promotion disabled. ${bundle.scoring.promotion.reasons.map(text).join('; ')}`, '',
    'Emulation covers only documented-style stopwords, conventional test/docs/fixture paths and a simple entropy floor; it is not a gitleaks rerun and omits repository allowlists, rule-specific regexes, scanner internals and historical scanning.',
    'Unsafe path-dismiss is an evaluation-only ablation. Match-line uses a separate no-folder pipeline pass. Neither human decisions nor audit insertion changes automated bands.', '');
  return lines.join('\n');
}
export function limitationsMarkdown(bundle: ReportBundle, samples: readonly Sample[]): string {
  const byKey = new Map(samples.map(sample => [sample.key, sample]));
  const lines = ['# Limitations and named failures', '', claim(bundle), '',
    'Author-written synthetic traps have a chosen prevalence; no external population claim. CredData is a later local WSL/Linux sensitivity study; SecretBench is excluded.',
    'Known-value masking is strict and may withhold benign digest/text collisions. Unreported credential detection is heuristic. Runtime safety, schema compatibility and model/pricing assumptions remain unverified until activation.', '', '## Every suppressed held-out real candidate'];
  for (const row of bundle.scoring.methods) {
    const failures = row.observations.filter(observation => byKey.get(observation.sampleKey)?.label && observation.band === 'dismiss');
    lines.push('', `### ${row.method}`, ...(failures.length ? failures.map(observation => {
      const sample = byKey.get(observation.sampleKey)!;
      return `- ${text(sample.key)}; trap ${text(sample.trap ?? 'background')}; signals ${sample.finding.signals.map(signal => signal.id).join(', ') || 'none'}.`;
    }) : ['None in this computed row, or row not run; consult its status.']));
    const surviving = row.observations.filter(observation => byKey.get(observation.sampleKey)?.label === false && observation.band !== 'dismiss').slice(0, 20);
    lines.push('', 'Surviving false positives (first 20, candidate order):', ...surviving.map(observation => `- ${text(observation.sampleKey)}; ${text(byKey.get(observation.sampleKey)?.trap ?? 'background')}.`));
  }
  const llm = bundle.scoring.methods.find(row => row.method === 'llm-only');
  const combined = new Map(bundle.scoring.methods.find(row => row.method === 'generative')?.observations.map(observation => [observation.sampleKey, observation]) ?? []);
  const wins = llm?.observations.filter(observation => {
    const sample = byKey.get(observation.sampleKey); const other = combined.get(observation.sampleKey);
    return sample && other && (sample.label ? observation.band !== 'dismiss' && other.band === 'dismiss' : observation.band === 'dismiss' && other.band !== 'dismiss');
  }) ?? [];
  lines.push('', '## Cases where LLM-only beats the combined row', ...wins.map(observation => `- ${text(observation.sampleKey)}.`), ...(wins.length ? [] : ['No such case in the available rows, or live rows not run.']), '');
  return lines.join('\n');
}
