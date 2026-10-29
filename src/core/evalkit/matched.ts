import type { MatchedPoint, SweepPoint } from './types.ts';

/** Best reduction meeting this method's own target; no denominator or unreachable recall means unavailable. */
export function matchedRecall(curve: readonly SweepPoint[], targetRecall: number): MatchedPoint {
  if (!Number.isFinite(targetRecall) || targetRecall <= 0 || targetRecall > 1) throw new Error('Invalid recall target.');
  const eligible = curve.filter((point) => point.metrics.recall !== null && point.metrics.recall >= targetRecall && point.metrics.reduction !== null);
  eligible.sort((a, b) => (b.metrics.reduction as number) - (a.metrics.reduction as number) || (b.metrics.recall as number) - (a.metrics.recall as number) || (a.dismissThreshold ?? -1) - (b.dismissThreshold ?? -1));
  return { targetRecall, attainable: eligible.length > 0, point: eligible[0] ?? null };
}
