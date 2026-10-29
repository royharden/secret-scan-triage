import { SCORED_METHODS, reclassify } from '../methods/index.ts';
import type { Thresholds } from '../policy/thresholds.ts';
import { computeMetrics } from './metrics.ts';
import type { MethodId, Observation, Sample, SweepPoint } from './types.ts';

/** Descriptive curve only; a null threshold is the conservative no-judge-dismissal point. */
export function thresholdsAt(base: Thresholds, dismissal: number | null): Thresholds {
  if (dismissal === null) return { ...base, judge_dismiss_enabled: false };
  if (!Number.isFinite(dismissal) || dismissal < 0 || dismissal >= 1) throw new Error('Invalid sweep threshold.');
  return { ...base, judge_dismiss_enabled: true, infeasible: false, t_dismiss: dismissal, t_keep: Math.max(base.t_keep, Math.min(1, dismissal + 2 * Number.EPSILON)) };
}
export function scoreSweep(method: MethodId, samples: readonly Sample[], observations: readonly Observation[], thresholds: Thresholds, highPrecisionRules: readonly string[]): SweepPoint[] {
  if (!SCORED_METHODS.includes(method)) return [{ dismissThreshold: null, metrics: computeMetrics(samples, observations) }];
  const scores = observations.flatMap((o) => o.judge?.status === 'ok' && o.judge.reason_code !== 'cannot_tell' && Number.isFinite(o.judge.p_real) && o.judge.p_real >= 0 && o.judge.p_real < 1 ? [o.judge.p_real] : []);
  const candidates: (number | null)[] = [null, ...[...new Set(scores)].sort((a, b) => a - b)];
  return candidates.map((dismissThreshold) => ({ dismissThreshold, metrics: computeMetrics(samples, reclassify(method, samples, observations, thresholdsAt(thresholds, dismissThreshold), highPrecisionRules)) }));
}
