import { describe, expect, it } from 'vitest';
import { computeMetrics } from '../../src/core/evalkit/metrics.ts';
import { wilson } from '../../src/core/evalkit/wilson.ts';
import { bootstrapReduction, makeBootstrapPlan, pairedReductionDifference } from '../../src/core/evalkit/bootstrap.ts';
import { groupedSplit, validateSamples } from '../../src/core/evalkit/split.ts';
import { matchedRecall } from '../../src/core/evalkit/matched.ts';
import { tuneDev } from '../../src/core/evalkit/tune.ts';
import { classifyMethod } from '../../src/core/methods/index.ts';
import { observation, sample, thresholds } from './helpers.ts';

describe('hand-calculable automated metrics', () => {
  it('uses surfaced bands and explicit zero-denominator N/A', () => {
    const samples = [sample(0, true), sample(1, true), sample(2, false), sample(3, false)];
    const metrics = computeMetrics(samples, samples.map((s, i) => observation(s, (['keep', 'dismiss', 'dismiss', 'review'] as const)[i])));
    expect(metrics).toMatchObject({ n: 4, real: 2, negative: 2, recall: .5, reduction: .5, reviewRate: .25, keepPrecision: 1 });
    expect(metrics.recallInterval?.low).toBeCloseTo(.0945312, 6);
    expect(metrics.recallInterval?.high).toBeCloseTo(.9054688, 6);
    expect(computeMetrics([], [])).toMatchObject({ recall: null, reduction: null, reviewRate: null, keepPrecision: null, recallInterval: null });
    expect(computeMetrics([samples[0]], [])).toMatchObject({ n: 1, recall: 1, reduction: null, reviewRate: 1 });
    expect(wilson(0, 0)).toBeNull(); expect(() => wilson(2, 1)).toThrow();
  });
  it('preserves blocked candidates in the denominator and surfaces them conservatively', () => {
    const samples = [sample(0, true), sample(1, false)];
    const rows = samples.map((s) => ({ ...observation(s, 'dismiss'), guardBlocked: true }));
    expect(computeMetrics(samples, rows)).toMatchObject({ n: 2, real: 1, negative: 1, recall: 1, reduction: 0, reviewRate: 1 });
  });
});

describe('grouped split and paired cluster uncertainty', () => {
  it('weights whole sampled groups and counts undefined replicates', () => {
    // what_bug_this_catches: row bootstrap or independent method resampling gives a different paired interval.
    const samples = [sample(0, false, 'A'), sample(1, false, 'B'), sample(2, true, 'C')];
    const left = samples.map((s, i) => observation(s, i === 0 ? 'dismiss' : 'review'));
    const right = samples.map((s) => observation(s, 'review'));
    const plan = { seed: 1, groups: ['A', 'B', 'C'], draws: [[0, 0, 0], [1, 1, 1], [2, 2, 2]] };
    expect(bootstrapReduction(samples, left, plan)).toEqual({ interval: { low: .025, high: .975 }, valid: 2, undefined: 1 });
    expect(pairedReductionDifference(samples, left, right, plan)).toEqual({ interval: { low: .025, high: .975 }, valid: 2, undefined: 1 });
    expect(pairedReductionDifference(samples, left, left, plan).interval).toEqual({ low: 0, high: 0 });
    expect(makeBootstrapPlan(['A', 'B'], 26, 5)).toEqual(makeBootstrapPlan(['B', 'A', 'A'], 26, 5));
  });
  it('keeps group membership together and rejects cross-split/repeated-value leakage', () => {
    const rows = [{ group: 'A', n: 1 }, { group: 'A', n: 2 }, { group: 'B', n: 3 }];
    const split = groupedSplit(rows, 26);
    expect(split.dev.some((s) => s.group === 'A') && split.heldout.some((s) => s.group === 'A')).toBe(false);
    const a = sample(0, true, 'A', 'dev'), b = sample(1, true, 'A', 'heldout');
    expect(() => validateSamples([a, b])).toThrow();
    b.group = 'B'; b.finding.valueTag = a.finding.valueTag;
    expect(() => validateSamples([a, b])).toThrow();
  });
});

describe('independent methods, matched recall and dev-only tuning', () => {
  it('keeps scoreless methods at one point and reports unattainable targets', () => {
    const s = sample(0, true);
    const point = { dismissThreshold: null, metrics: computeMetrics([s], [observation(s, 'dismiss')]) };
    expect(matchedRecall([point], .98)).toEqual({ targetRecall: .98, attainable: false, point: null });
  });
  it('does not secretly wrap LLM-only/emulation with deployed verified policy', () => {
    const s = sample(0, true);
    s.finding.signals = [{ id: 'S-R1', name: 'verified', direction: 'real', strength: 'decisive', evidence: { kind: 'span', lineId: 'L0' } }];
    s.finding.features.pathClass = 'test';
    const scored = observation(s, 'review', .01).judge;
    const enabled = { ...thresholds, judge_dismiss_enabled: true };
    expect(classifyMethod('generative', s, scored, enabled, [])).toBe('keep');
    expect(classifyMethod('llm-only', s, scored, enabled, [])).toBe('dismiss');
    expect(classifyMethod('allowlist', s, undefined, enabled, [])).toBe('review');
    expect(classifyMethod('unsafe-path-dismiss', s, undefined, enabled, [])).toBe('dismiss');
  });
  it('tunes only live-origin dev observations, retaining the supplied keep threshold', () => {
    const samples = [sample(0, true, 'A', 'dev'), sample(1, true, 'B', 'dev'), sample(2, false, 'C', 'dev'), sample(3, false, 'D', 'dev')];
    const rows = samples.map((s, i) => observation(s, 'review', [.9, .8, .1, .2][i]));
    const input = { samples, observations: rows, method: 'generative' as const, baseThresholds: thresholds, highPrecisionRules: [], targetRecall: .98 };
    expect(tuneDev(input)).toMatchObject({ feasible: true, thresholds: { source: 'dev-tuned', t_dismiss: .2, t_keep: .85, judge_dismiss_enabled: true } });
    expect(() => tuneDev({ ...input, samples: samples.map((s) => ({ ...s, split: 'heldout' as const })) })).toThrow();
    expect(() => tuneDev({ ...input, observations: rows.map((o) => ({ ...o, source: 'scripted-mock' as const, origin: 'scripted-mock' as const })) })).toThrow();
    samples[0].finding.signals = [{ id: 'S-F1', name: 'sentinel', direction: 'fp', strength: 'decisive', evidence: { kind: 'span', lineId: 'L0' } }];
    expect(tuneDev(input)).toMatchObject({ feasible: false, thresholds: { infeasible: true, judge_dismiss_enabled: false } });
  });
});
