import { describe, expect, it } from 'vitest';
import { runEvaluation } from '../../src/core/evalkit/run.ts';
import { JudgeCache, createCacheIdentity } from '../../src/core/evalkit/cache.ts';
import { makeBootstrapPlan } from '../../src/core/evalkit/bootstrap.ts';
import { createMockJudge } from '../../src/core/providers/mock.ts';
import { buildMaskedView } from '../../src/core/judge/views.ts';
import { buildLeakGuard } from '../../src/core/mask/leakIndex.ts';
import { NOT_READY_GUARD, unsafeMarkSafe } from '../../src/core/safe.ts';
import { fakeLive, sample, thresholds } from './helpers.ts';

const emptyGuard = () => buildLeakGuard([], [], new Uint8Array(32).fill(26));
describe('evaluation runner provenance and safety', () => {
  it('keeps absent live rows not-run and mock measurements null, including replay', async () => {
    const samples = [sample(0, true), sample(1, false)];
    const base = { samples, guard: emptyGuard(), thresholds, highPrecisionRules: [], bootstrap: makeBootstrapPlan(samples.map((s) => s.group), 26, 5) };
    const missing = await runEvaluation({ ...base, judges: {} });
    expect(missing.methods.find((m) => m.method === 'generative')).toMatchObject({ status: 'not-run', metrics: null });
    expect(missing.methods.find((m) => m.method === 'scanner')?.curve).toHaveLength(1);
    const cache = new JudgeCache(), mock = createMockJudge(26);
    const first = await runEvaluation({ ...base, judges: { generative: mock, jev: mock }, cache });
    const second = await runEvaluation({ ...base, judges: { generative: mock, jev: mock }, cache });
    for (const scored of [first, second].flatMap((r) => r.methods.filter((m) => ['generative', 'llm-only', 'jev'].includes(m.method)))) {
      expect(scored).toMatchObject({ status: 'interface-replay', usage: null, measuredLatencyMs: null, cachedLatencyMs: null });
    }
    expect(second.methods.find((m) => m.method === 'llm-only')?.observations.every((o) => o.source === 'replay')).toBe(true);
    expect(second.promotion.promoted).toBe(false);
  });
  it('pure in-process baselines keep their definitions when the outbound guard is unavailable', async () => {
    const samples = [sample(0, true), sample(1, false)];
    const scored = await runEvaluation({ samples, guard: NOT_READY_GUARD, thresholds, highPrecisionRules: [], judges: {}, bootstrap: makeBootstrapPlan(samples.map((s) => s.group), 26, 3) });
    expect(scored.methods.find((m) => m.method === 'deterministic')).toMatchObject({ metrics: { n: 2, real: 1, negative: 1, recall: 1, reduction: 0 } });
    expect(scored.methods.find((m) => m.method === 'deterministic')?.observations.every((o) => !o.guardBlocked && o.band === 'review')).toBe(true);
  });
  it('unwrapped emulation ignores colliding unrelated metadata; LLM-only guards only its actual masked view', async () => {
    // what_bug_this_catches: guarding a whole Finding silently changed the named independent comparators.
    const samples = [sample(0, false)];
    const marker = ['UNRELATED_', 'METADATA_', 'MARKER'].join('');
    samples[0].finding.commit = marker;
    samples[0].emulation.allowedPath = true;
    const guard = buildLeakGuard([marker], [], new Uint8Array(32).fill(26));
    const input = { samples, guard, thresholds, highPrecisionRules: [], judges: { generative: fakeLive(() => .9) }, bootstrap: makeBootstrapPlan(['g0'], 26, 3) };
    const scored = await runEvaluation(input);
    expect(scored.methods.find(m => m.method === 'allowlist')).toMatchObject({ metrics: { n: 1, reduction: 1 }, observations: [{ band: 'dismiss', origin: 'deterministic' }] });
    expect(scored.methods.find(m => m.method === 'llm-only')?.observations[0]).toMatchObject({ band: 'keep', source: 'live' });
    const viewGuard = buildLeakGuard(['value ='], [], new Uint8Array(32).fill(27));
    const blocked = await runEvaluation({ ...input, guard: viewGuard });
    expect(blocked.methods.find(m => m.method === 'allowlist')?.observations[0].band).toBe('dismiss');
    expect(blocked.methods.find(m => m.method === 'llm-only')?.observations[0]).toMatchObject({ band: 'review', guardBlocked: true });
  });
  it('preserves charged live usage and timing when unsafe response text or cache insertion is rejected', async () => {
    // what_bug_this_catches: the catch reset a paid call to deterministic review with zero measured cost/latency.
    const samples = [sample(0, true)];
    const marker = ['BLOCKED_', 'MODEL_', 'TEXT'].join('');
    const plain = fakeLive(() => .9);
    const unsafe = { ...plain, async judge(view: Parameters<typeof plain.judge>[0]) {
      return { ...await plain.judge(view), model_text: unsafeMarkSafe(marker), model_text_label: 'model-authored' as const };
    } };
    class RejectingCache extends JudgeCache { override async put(): Promise<void> { throw new Error(''); } }
    for (const failure of ['text', 'cache'] as const) {
      const scored = await runEvaluation({ samples, guard: failure === 'text' ? buildLeakGuard([marker], [], new Uint8Array(32).fill(26)) : emptyGuard(),
        thresholds, highPrecisionRules: [], judges: { generative: failure === 'text' ? unsafe : plain },
        cache: failure === 'cache' ? new RejectingCache() : undefined, bootstrap: makeBootstrapPlan(['g0'], 26, 3) });
      const row = scored.methods.find(m => m.method === 'generative')!;
      expect(row.metrics).toMatchObject({ n: 1, real: 1, recall: 1 });
      expect(row.usage).toEqual({ calls: 1, inputTokens: 10, outputTokens: 5, usd: .01 });
      expect(row.measuredLatencyMs).not.toBeNull();
      expect(row.observations[0]).toMatchObject({ source: 'live', origin: 'live', band: 'review',
        attemptUsage: { calls: 1, usd: .01 }, judge: { status: 'failed' } });
      expect(row.observations[0].judge?.model_text).toBeUndefined();
      if (failure === 'text') expect(row.observations[0].guardBlocked).toBe(true);
    }
  });
  it('uses available numeric adapter failure receipts, and reports unknown dispatched accounting as N/A', async () => {
    const samples = [sample(0, true)];
    const plain = fakeLive(() => .9);
    for (const receipt of [null, { calls: 1, inputTokens: 7, outputTokens: 0, usd: .004 }]) {
      const judge = { ...plain, async judge(): Promise<never> { throw receipt ? { usage: receipt } : new Error(''); } };
      const scored = await runEvaluation({ samples, guard: emptyGuard(), thresholds, highPrecisionRules: [], judges: { generative: judge }, bootstrap: makeBootstrapPlan(['g0'], 26, 3) });
      const row = scored.methods.find(m => m.method === 'generative')!;
      expect(row.usage).toEqual(receipt);
      expect(row.measuredLatencyMs).not.toBeNull();
      expect(row.observations[0]).toMatchObject({ source: 'live', origin: 'live', band: 'review', attemptUsage: receipt });
    }
  });
  it('promotes only live held-out superiority against BOTH comparators at preregistered .98', async () => {
    // Fake injected judges exercise the criterion; this test is not an actual live experiment.
    const samples = [sample(0, true, 'A'), sample(1, false, 'A'), sample(2, true, 'B'), sample(3, false, 'B')];
    const isReal = (key: string) => key === 'candidate-0' || key === 'candidate-2';
    const input = { samples, guard: emptyGuard(), thresholds, highPrecisionRules: [], bootstrap: makeBootstrapPlan(['A', 'B'], 26, 6), judges: { generative: fakeLive((id) => isReal(id) ? .1 : .99), jev: fakeLive((id) => isReal(id) ? .99 : .1, 'system-one') } };
    const superior = await runEvaluation(input);
    expect(superior.promotion).toMatchObject({ eligible: true, promoted: true, equivalenceEnabled: false });
    expect(superior.paired.every((p) => p.bootstrap?.interval?.low === 1)).toBe(true);
    expect((await runEvaluation({ ...input, targetRecall: .95 })).promotion.promoted).toBe(false);
    expect((await runEvaluation({ ...input, judges: { ...input.judges, jev: input.judges.generative } })).promotion.promoted).toBe(false);
  });
});

describe('cross-process guarded cache', () => {
  it('imports validated entries as replay without relabelling mock or measuring fresh latency', async () => {
    const guard = emptyGuard(), mock = createMockJudge(26);
    const view = buildMaskedView(sample(0, true).finding)!;
    const identity = await createCacheIdentity(view, mock.descriptor, 'config-v1', guard);
    const result = await mock.judge(view);
    const cache = new JudgeCache();
    await cache.put({ identity, result, source: 'scripted-mock', origin: 'scripted-mock', measuredLatencyMs: null, createdAt: '2026-10-24T00:00:00.000Z' }, guard);
    const imported = new JudgeCache();
    await imported.importEntries(cache.entries(), guard);
    expect(await imported.get(identity, guard)).toMatchObject({ source: 'replay', origin: 'scripted-mock', measuredLatencyMs: null });
    await expect(imported.importEntries([{ ...cache.entries()[0], origin: 'live', source: 'live' }], guard)).rejects.toThrow();
    await expect(imported.importEntries([{ ...cache.entries()[0], identity: { ...identity, schemaVersion: 'unknown' } }], guard)).rejects.toThrow();
    const collision = buildLeakGuard([result.reason_code], [], new Uint8Array(32).fill(2));
    expect(() => imported.entries(collision)).toThrow();
  });
});
