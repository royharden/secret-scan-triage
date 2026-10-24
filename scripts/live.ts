// M5 reconciles this injected factory with budgeted provider adapters. No network or mock fallback here.
import type { LeakGuard } from '../src/core/safe.ts';
import type { DescribedJudge } from '../src/core/providers/types.ts';
export async function createEvalJudges(_guard: LeakGuard, _maxUsd: number): Promise<{ generative?: DescribedJudge; jev?: DescribedJudge }> {
  return {}; // Explicit not-run rows until live-path construction/activation, never fabricated live responses.
}
