import { loadThresholds } from '../policy/thresholds.ts';
import { observationMap } from './metrics.ts';
import { validateSamples } from './split.ts';
import { matchedRecall } from './matched.ts';
import { scoreSweep } from './sweep.ts';
import type { TuneInput, TuningResult } from './types.ts';

/** No files are written here. Only complete dev observations of actual live origin may tune a live artifact. */
export function tuneDev(input: TuneInput): TuningResult {
  validateSamples(input.samples);
  const byKey = observationMap(input.samples, input.observations);
  if (!input.samples.length || input.samples.some((s) => s.split !== 'dev')) throw new Error('Tuning requires dev-only samples.');
  if (byKey.size !== input.samples.length || input.observations.some((o) => o.origin !== 'live' && o.origin !== 'deterministic') || !input.observations.some((o) => o.origin === 'live' && o.judge?.status === 'ok' && !o.guardBlocked)) throw new Error('Live-origin dev observations required.');
  if (input.observations.some((o) => o.source === 'scripted-mock' || o.judge?.provider === 'mock')) throw new Error('Scripted mock cannot tune live thresholds.');
  const base = loadThresholds(input.baseThresholds);
  const curve = scoreSweep(input.method, input.samples, input.observations, base, input.highPrecisionRules)
    .filter((p) => p.dismissThreshold === null || p.dismissThreshold < base.t_keep);
  const best = matchedRecall(curve, input.targetRecall);
  if (!best.attainable || !best.point) {
    return { thresholds: loadThresholds({ ...base, source: 'dev-tuned', target_recall: input.targetRecall, judge_dismiss_enabled: false, infeasible: true }), feasible: false, reason: 'Target recall is infeasible on dev; judge dismissal remains disabled.' };
  }
  const threshold = best.point.dismissThreshold;
  return { thresholds: loadThresholds({ ...base, source: 'dev-tuned', target_recall: input.targetRecall, t_dismiss: threshold ?? base.t_dismiss, judge_dismiss_enabled: threshold !== null, infeasible: false }), feasible: true };
}
