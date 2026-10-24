// Per-import live accounting, independent of currently visible judge rows and whole-budget accounting panels.
import type { JudgeResult } from '../core/judge/contract.ts';
export interface RunLiveAccounting {
  actions: number;
  pending: number;
  actualUsd: number;
  estimatedUsd: number;
  uncertain: boolean;
}
/** Install before awaiting any live operation. A prior incomplete action can never be certified by a later success. */
export function beginRunLive(previous?: RunLiveAccounting): RunLiveAccounting {
  return { actions: (previous?.actions ?? 0) + 1, pending: (previous?.pending ?? 0) + 1,
    actualUsd: previous?.actualUsd ?? 0, estimatedUsd: previous?.estimatedUsd ?? 0,
    uncertain: previous?.uncertain === true || (previous?.pending ?? 0) > 0 };
}
function validUsage(result: JudgeResult): boolean {
  return result.provider !== 'mock' && !!result.usage
    && ['calls', 'inputTokens', 'outputTokens'].every(key => Number.isSafeInteger(result.usage[key as keyof typeof result.usage]) && result.usage[key as keyof typeof result.usage] >= 0)
    && typeof result.usage.usd === 'number' && Number.isFinite(result.usage.usd) && result.usage.usd >= 0;
}
/** Copy only validated accounting. Partial/null/estimated/unknown batches remain sticky-uncertain. Pending stays latched. */
export function recordRunLive(state: RunLiveAccounting, results: readonly (JudgeResult | null)[], failed: number, expected: number): RunLiveAccounting {
  let actualUsd = state.actualUsd;
  let estimatedUsd = state.estimatedUsd;
  let uncertain = state.uncertain || failed !== 0 || results.length !== expected;
  for (const result of results) {
    if (!result || !validUsage(result) || result.usage_unknown) { uncertain = true; continue; }
    if (result.usage_estimated) { estimatedUsd += result.usage.usd; uncertain = true; }
    else actualUsd += result.usage.usd;
  }
  if (!Number.isFinite(actualUsd) || !Number.isFinite(estimatedUsd)) return { ...state, uncertain: true };
  return { ...state, actualUsd, estimatedUsd, uncertain };
}
/** Call successful completion only after all guarded response/audit/state preparation finishes. Catch paths stay uncertain. */
export function finishRunLive(state: RunLiveAccounting, completed: boolean): RunLiveAccounting {
  return { ...state, pending: Math.max(0, state.pending - 1), uncertain: state.uncertain || !completed };
}
export function measuredRunCost(state: RunLiveAccounting | undefined): number | null {
  return state && state.actions > 0 && state.pending === 0 && !state.uncertain && state.estimatedUsd === 0
    && Number.isFinite(state.actualUsd) && state.actualUsd >= 0 ? state.actualUsd : null;
}
