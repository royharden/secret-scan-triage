import { describe, expect, it, vi } from 'vitest';
import { RpcCallLedger } from '../../supabase/functions/triage-judge/reserve.ts';
describe('service accounting RPC adapter', () => {
  it('uses exact trusted-owner RPC names/args, never stores views or client caps', async () => {
    const rpc = vi.fn(async (name: string) => ({ error: null, data: name === 'open_judge_budget'
      ? { budget_id: 'budget', cap_usd: 1, expires_at: '2026-10-24T23:00:00Z' }
      : name === 'claim_judge_dispatch' ? { usage_id: 'usage', status: 'dispatching', claimed: true }
        : { usage_id: 'usage', status: name === 'reserve_judge_usage' ? 'reserved' : 'ambiguous', est_cost_usd: 0.1, actual_cost_usd: null } }));
    const ledger = new RpcCallLedger({ rpc }, 'verified-owner', { sessionUsd: 1, userDayUsd: 2, globalDayUsd: 3 }, 'budget');
    await ledger.openBudget();
    const row = await ledger.reserve({ requestId: 'request:0', attempt: 2, payloadHash: 'a'.repeat(64), provider: 'typesafe',
      modelId: 'jev-1.13.0', units: 1, estimateUsd: 0.1, promptFingerprint: 'b'.repeat(64) });
    expect(await ledger.claim(row.usageId)).toBe(true); await ledger.settle(row.usageId, 'ambiguous');
    expect(rpc.mock.calls.map((call) => call[0])).toEqual(['open_judge_budget', 'reserve_judge_usage', 'claim_judge_dispatch', 'settle_judge_usage']);
    expect(rpc).toHaveBeenCalledWith('reserve_judge_usage', expect.objectContaining({ p_user_id: 'verified-owner', p_attempt: 2,
      p_user_day_cap_usd: 2, p_global_day_cap_usd: 3, p_payload_hash: 'a'.repeat(64), p_prompt_fingerprint: 'b'.repeat(64) }));
    expect(rpc).toHaveBeenCalledWith('settle_judge_usage', { p_user_id: 'verified-owner', p_usage_id: 'usage', p_outcome: 'ambiguous', p_actual_cost_usd: null });
  });
});
