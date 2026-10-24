import type { Counts, Metrics, Observation, Sample } from './types.ts';
import { wilson } from './wilson.ts';

export function emptyCounts(): Counts {
  return { n: 0, real: 0, negative: 0, surfacedReal: 0, surfacedNegative: 0, reviewed: 0, kept: 0, keptReal: 0 };
}
export function addCounts(a: Counts, b: Counts): Counts {
  return {
    n: a.n + b.n, real: a.real + b.real, negative: a.negative + b.negative,
    surfacedReal: a.surfacedReal + b.surfacedReal, surfacedNegative: a.surfacedNegative + b.surfacedNegative,
    reviewed: a.reviewed + b.reviewed, kept: a.kept + b.kept, keptReal: a.keptReal + b.keptReal,
  };
}
export function observationMap(samples: readonly Sample[], observations: readonly Observation[]): Map<string, Observation> {
  const keys = new Set(samples.map((s) => s.key));
  if (keys.size !== samples.length) throw new Error('Duplicate candidate key.');
  const out = new Map<string, Observation>();
  for (const observation of observations) {
    if (!keys.has(observation.sampleKey) || out.has(observation.sampleKey) || !['keep', 'review', 'dismiss'].includes(observation.band)) throw new Error('Invalid observation coverage.');
    out.set(observation.sampleKey, observation);
  }
  return out;
}
export function countsByGroup(samples: readonly Sample[], observations: readonly Observation[]): Map<string, Counts> {
  const byKey = observationMap(samples, observations);
  const out = new Map<string, Counts>();
  for (const sample of samples) {
    // Missing/blocked observations conservatively remain surfaced in review; NEVER remove a candidate denominator.
    const observation = byKey.get(sample.key);
    const band = observation?.guardBlocked ? 'review' : observation?.band ?? 'review';
    const c = out.get(sample.group) ?? emptyCounts();
    c.n++;
    if (sample.label) c.real++; else c.negative++;
    if (band !== 'dismiss') { if (sample.label) c.surfacedReal++; else c.surfacedNegative++; }
    if (band === 'review') c.reviewed++;
    if (band === 'keep') { c.kept++; if (sample.label) c.keptReal++; }
    out.set(sample.group, c);
  }
  return out;
}
export function metricsFromCounts(c: Counts): Metrics {
  return {
    n: c.n, real: c.real, negative: c.negative, surfacedReal: c.surfacedReal, surfacedNegative: c.surfacedNegative,
    recall: c.real === 0 ? null : c.surfacedReal / c.real,
    reduction: c.negative === 0 ? null : 1 - c.surfacedNegative / c.negative,
    reviewRate: c.n === 0 ? null : c.reviewed / c.n,
    keepPrecision: c.kept === 0 ? null : c.keptReal / c.kept,
    recallInterval: wilson(c.surfacedReal, c.real),
  };
}
export function computeMetrics(samples: readonly Sample[], observations: readonly Observation[]): Metrics {
  let counts = emptyCounts();
  for (const group of countsByGroup(samples, observations).values()) counts = addCounts(counts, group);
  return metricsFromCounts(counts);
}
