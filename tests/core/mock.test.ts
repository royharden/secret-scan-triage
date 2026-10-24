// Scripted mock judge 'mock-scripted-v1': determinism, order independence, provenance (never an LLM), contract validity.
import { describe, expect, it } from 'vitest';
import { unsafeMarkSafe } from '../../src/core/safe.ts';
import type { LeakGuard } from '../../src/core/safe.ts';
import type { MaskedView } from '../../src/core/judge/contract.ts';
import { isInvalid, validateJudgeOutput } from '../../src/core/judge/validate.ts';
import { createMockJudge, MOCK_JUDGE_ID, scriptedScore } from '../../src/core/providers/mock.ts';

const passGuard: LeakGuard = { ready: true, check() {}, exemptDigests: () => 0 };

function view(id: string, buckets: string[], over: Partial<MaskedView> = {}): MaskedView {
  return {
    findingId: id, ruleId: 'generic-api-key', pathClass: 'source', basename: unsafeMarkSafe('app.ts'),
    maskedLine: unsafeMarkSafe('key = "****"'), maskedWindow: [{ lineId: 'L0', text: unsafeMarkSafe('key = "****"') }],
    lengthBucket: 'm', entropyBucket: 'mid', charClass: 'alnum', signalBuckets: buckets, scannerVerified: false, ...over,
  };
}

const VIEWS: MaskedView[] = [
  view('f1', []),
  view('f2', ['S-R1:real:decisive']),
  view('f3', ['S-F2:fp:decisive']),
  view('f4', ['S-R3:real:strong', 'S-F11:fp:weak']),
  view('f5', ['S-F5:fp:strong', 'S-F9:fp:weak']),
  view('f6', ['S-F6:fp:strong']),
  view('f7', [], { entropyBucket: 'high' }),
  view('f8', [], { entropyBucket: 'low' }),
  view('f9', ['S-R5:real:strong']),
  view('f10', ['S-F10:fp:weak']),
];

describe('createMockJudge', () => {
  it('is deterministic for the same seed and view', async () => {
    const a = createMockJudge(7);
    const b = createMockJudge(7);
    for (const v of VIEWS) expect(await a.judge(v)).toEqual(await b.judge(v));
  });
  it('does not depend on call order', async () => {
    const a = createMockJudge(7);
    const b = createMockJudge(7);
    const forward = await Promise.all(VIEWS.map((v) => a.judge(v)));
    const backward = (await Promise.all([...VIEWS].reverse().map((v) => b.judge(v)))).reverse();
    expect(forward).toEqual(backward);
  });
  it('different seeds change the jitter', async () => {
    const a = await Promise.all(VIEWS.map((v) => createMockJudge(1).judge(v)));
    const b = await Promise.all(VIEWS.map((v) => createMockJudge(2).judge(v)));
    expect(a.map((r) => r.p_real)).not.toEqual(b.map((r) => r.p_real));
  });
  it('is labelled as a scripted mock, never an LLM, with zero usage', async () => {
    const m = createMockJudge(3);
    expect(m.id).toBe(MOCK_JUDGE_ID);
    expect(MOCK_JUDGE_ID).toBe('mock-scripted-v1');
    expect(m.descriptor).toMatchObject({ provider: 'mock', kind: 'scripted-mock', isLlm: false });
    for (const v of VIEWS) {
      const r = await m.judge(v);
      expect(r).toMatchObject({ provider: 'mock', modelId: 'mock-scripted-v1', status: 'ok' });
      expect(r.usage).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 });
      expect(Number.isFinite(r.p_real)).toBe(true);
      expect(r.p_real).toBeGreaterThanOrEqual(0.01);
      expect(r.p_real).toBeLessThanOrEqual(0.99);
    }
  });
  it('follows the script: decisive real high, decisive reference low', () => {
    expect(scriptedScore(view('x', ['S-R1:real:decisive']), 1)).toMatchObject({ reason_code: 'looks_real' });
    expect(scriptedScore(view('x', ['S-R1:real:decisive']), 1).p_real).toBeGreaterThanOrEqual(0.9);
    const ref = scriptedScore(view('x', ['S-F2:fp:decisive']), 1);
    expect(ref.p_real).toBeLessThanOrEqual(0.4);
    expect(ref.reason_code).toBe('reference_not_literal');
  });
  it('outputs satisfy the strict judge contract (citations inside the window when present)', async () => {
    const m = createMockJudge(11);
    for (const v of VIEWS) {
      const r = await m.judge(v);
      const { p_real, reason_code, cited_lines } = r;
      const checked = validateJudgeOutput({ p_real, reason_code, cited_lines }, v, { citationsRequired: true }, passGuard);
      expect(isInvalid(checked)).toBe(false);
    }
    const noL0 = view('n', [], { maskedWindow: [] });
    expect((await m.judge(noL0)).cited_lines).toBeUndefined();
  });
  it('rejects a non-finite seed', () => {
    expect(() => createMockJudge(Number.NaN)).toThrow();
  });
});
