// Scripted mock judge 'mock-scripted-v1' (Claude §2.6). A PURE deterministic function of the view's signal buckets
// (plus entropy bucket when no buckets are present, e.g. the LLM-only view) and a seeded jitter keyed by (seed, findingId).
// No network, zero usage, provider 'mock'. It is never labelled or reported as an LLM.
import { createRng, hashString32 } from '../rng.ts';
import type { JudgeResult, MaskedView, ReasonCode } from '../judge/contract.ts';
import type { DescribedJudge, JudgeDescriptor } from './types.ts';

export const MOCK_JUDGE_ID = 'mock-scripted-v1';

interface Bucket {
  id: string;
  direction: 'real' | 'fp';
  strength: 'decisive' | 'strong' | 'weak';
}

export function parseBucket(b: string): Bucket | null {
  const m = /^(S-[RF][0-9]{1,2}):(real|fp):(decisive|strong|weak)$/.exec(b);
  if (!m) return null;
  return { id: m[1] as string, direction: m[2] as Bucket['direction'], strength: m[3] as Bucket['strength'] };
}

/** Seeded jitter in [-0.05, 0.05), independent of call order. */
export function mockJitter(seed: number, findingId: string): number {
  const s = (Math.trunc(seed) ^ hashString32(findingId)) >>> 0;
  return (createRng(s).next() - 0.5) * 0.1;
}

const FP_REASON_PRIORITY: ReadonlyArray<[string, ReasonCode]> = [
  ['S-F1', 'docs_example'],
  ['S-F2', 'reference_not_literal'],
  ['S-F5', 'placeholder'],
  ['S-F8', 'placeholder'],
  ['S-F3', 'hash_or_id'],
  ['S-F6', 'hash_or_id'],
  ['S-F7', 'hash_or_id'],
  ['S-F4', 'docs_example'],
  ['S-F11', 'test_value'],
  ['S-F9', 'placeholder'],
  ['S-F10', 'placeholder'],
];

function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

/** The scripted score, exported for tests. */
export function scriptedScore(view: MaskedView, seed: number): { p_real: number; reason_code: ReasonCode } {
  const buckets = view.signalBuckets.map(parseBucket).filter((b): b is Bucket => b !== null);
  let p: number;
  if (buckets.some((b) => b.direction === 'real' && b.strength === 'decisive')) {
    p = 0.97;
  } else if (buckets.length === 0) {
    p = view.entropyBucket === 'high' ? 0.68 : view.entropyBucket === 'mid' ? 0.5 : 0.3;
  } else {
    p = 0.5;
    for (const b of buckets) {
      if (b.direction === 'real') p += b.strength === 'strong' ? 0.2 : 0.05;
      else p -= b.strength === 'decisive' ? 0.3 : b.strength === 'strong' ? 0.18 : 0.06;
    }
  }
  p = round4(Math.min(0.99, Math.max(0.01, p + mockJitter(seed, view.findingId))));

  let reason: ReasonCode;
  if (p >= 0.6) {
    reason = 'looks_real';
  } else if (p > 0.4) {
    reason = 'cannot_tell';
  } else {
    const ids = new Set(buckets.filter((b) => b.direction === 'fp').map((b) => b.id));
    const hit = FP_REASON_PRIORITY.find(([id]) => ids.has(id));
    reason = hit ? hit[1] : 'cannot_tell';
  }
  return { p_real: p, reason_code: reason };
}

export function createMockJudge(seed: number): DescribedJudge {
  if (!Number.isFinite(seed)) throw new Error('createMockJudge: seed must be a finite number');
  const descriptor: JudgeDescriptor = Object.freeze({
    id: MOCK_JUDGE_ID,
    provider: 'mock',
    modelId: MOCK_JUDGE_ID,
    kind: 'scripted-mock',
    isLlm: false,
    citationsRequired: false,
  });
  return Object.freeze({
    id: MOCK_JUDGE_ID,
    descriptor,
    judge(view: MaskedView): Promise<JudgeResult> {
      const { p_real, reason_code } = scriptedScore(view, seed);
      const result: JudgeResult = {
        p_real,
        reason_code,
        usage: { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 },
        status: 'ok',
        provider: 'mock',
        modelId: MOCK_JUDGE_ID,
      };
      if (view.maskedWindow.some((l) => l.lineId === 'L0')) result.cited_lines = ['L0'];
      return Promise.resolve(result);
    },
  });
}
