import { createRng } from '../rng.ts';
import { addCounts, countsByGroup, emptyCounts } from './metrics.ts';
import type { BootstrapInterval, BootstrapPlan, Counts, Observation, Sample } from './types.ts';

export function makeBootstrapPlan(groups: readonly string[], seed: number, replicates = 2000): BootstrapPlan {
  if (!Number.isSafeInteger(replicates) || replicates < 1 || replicates > 20_000) throw new Error('Invalid bootstrap replicate count.');
  const unique = [...new Set(groups)].sort();
  const rng = createRng(seed);
  return {
    seed, groups: unique,
    draws: Array.from({ length: replicates }, () => unique.map(() => rng.int(0, unique.length))),
  };
}
export function validateBootstrapPlan(plan: BootstrapPlan, groups: readonly string[]): void {
  const expected = [...new Set(groups)].sort();
  if (!Number.isFinite(plan.seed) || plan.groups.length !== expected.length || new Set(plan.groups).size !== expected.length || expected.some((g) => !plan.groups.includes(g))) throw new Error('Bootstrap group mismatch.');
  if (plan.draws.length < 1 || plan.draws.length > 20_000) throw new Error('Invalid bootstrap plan.');
  for (const draw of plan.draws) if (draw.length !== plan.groups.length || draw.some((n) => !Number.isInteger(n) || n < 0 || n >= plan.groups.length)) throw new Error('Invalid bootstrap draw.');
}
function percentile(sorted: readonly number[], p: number): number {
  const at = (sorted.length - 1) * p;
  const low = Math.floor(at), high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}
function finish(values: number[], excluded: number): BootstrapInterval {
  values.sort((a, b) => a - b);
  return { interval: values.length ? { low: percentile(values, .025), high: percentile(values, .975) } : null, valid: values.length, undefined: excluded };
}
function totalFor(draw: readonly number[], plan: BootstrapPlan, groups: Map<string, Counts>): Counts {
  let total = emptyCounts();
  for (const i of draw) total = addCounts(total, groups.get(plan.groups[i]) ?? emptyCounts());
  return total;
}
export function bootstrapReduction(samples: readonly Sample[], observations: readonly Observation[], plan: BootstrapPlan): BootstrapInterval {
  validateBootstrapPlan(plan, samples.map((s) => s.group));
  const groups = countsByGroup(samples, observations);
  const values: number[] = [];
  let excluded = 0;
  for (const draw of plan.draws) {
    const total = totalFor(draw, plan, groups);
    if (total.negative === 0) excluded++;
    else values.push(1 - total.surfacedNegative / total.negative);
  }
  return finish(values, excluded);
}
export function pairedReductionDifference(samples: readonly Sample[], left: readonly Observation[], right: readonly Observation[], plan: BootstrapPlan): BootstrapInterval {
  validateBootstrapPlan(plan, samples.map((s) => s.group));
  const leftGroups = countsByGroup(samples, left), rightGroups = countsByGroup(samples, right);
  const values: number[] = [];
  let excluded = 0;
  for (const draw of plan.draws) {
    const a = totalFor(draw, plan, leftGroups), b = totalFor(draw, plan, rightGroups);
    if (a.negative === 0 || b.negative === 0) excluded++;
    else values.push((1 - a.surfacedNegative / a.negative) - (1 - b.surfacedNegative / b.negative));
  }
  return finish(values, excluded);
}

/** Descriptive matched-recall uncertainty reselects each method's OWN curve point inside every shared group draw. */
export function pairedMatchedReductionDifference(samples: readonly Sample[], leftCurve: readonly (readonly Observation[])[], rightCurve: readonly (readonly Observation[])[], plan: BootstrapPlan, targetRecall: number): BootstrapInterval {
  validateBootstrapPlan(plan, samples.map((s) => s.group));
  if (!Number.isFinite(targetRecall) || targetRecall <= 0 || targetRecall > 1) throw new Error('Invalid recall target.');
  const left = leftCurve.map((rows) => countsByGroup(samples, rows));
  const right = rightCurve.map((rows) => countsByGroup(samples, rows));
  const best = (draw: readonly number[], curves: Map<string, Counts>[]): number | null => {
    let value: number | null = null;
    for (const groups of curves) {
      const counts = totalFor(draw, plan, groups);
      if (!counts.real || !counts.negative || counts.surfacedReal / counts.real < targetRecall) continue;
      const reduction = 1 - counts.surfacedNegative / counts.negative;
      if (value === null || reduction > value) value = reduction;
    }
    return value;
  };
  const values: number[] = [];
  let excluded = 0;
  for (const draw of plan.draws) {
    const a = best(draw, left), b = best(draw, right);
    if (a === null || b === null) excluded++; else values.push(a - b);
  }
  return finish(values, excluded);
}
