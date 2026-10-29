import type { CallLedger, ReservationBinding, UsageReservation, UsageStatus } from './_shared/core/ledger/callledger.ts';
import type { ServerCaps } from './_shared/core/providers/serverConfig.ts';
export interface RpcClient { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> }
export interface BudgetInfo { budgetId: string; capUsd: number; expiresAt: string }
export interface BudgetStore extends CallLedger { openBudget(): Promise<BudgetInfo> }
function row(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('');
  return raw as Record<string, unknown>;
}
const STATUSES: readonly string[] = ['reserved', 'dispatching', 'settled', 'failed', 'ambiguous'];
function reservation(raw: unknown): UsageReservation {
  const r = row(raw);
  if (typeof r.usage_id !== 'string' || typeof r.status !== 'string' || !STATUSES.includes(r.status) ||
      typeof r.est_cost_usd !== 'number' || !Number.isFinite(r.est_cost_usd) || r.est_cost_usd <= 0 ||
      !(r.actual_cost_usd === null || (typeof r.actual_cost_usd === 'number' && Number.isFinite(r.actual_cost_usd) &&
        r.actual_cost_usd >= 0 && r.actual_cost_usd <= r.est_cost_usd))) throw new Error('');
  return { usageId: r.usage_id, status: r.status as UsageStatus, estimateUsd: r.est_cost_usd, actualUsd: r.actual_cost_usd as number | null };
}
/** Service-role client is injected ONLY after auth.getUser verified the JWT. No client caps/owner ids enter this adapter. */
export class RpcCallLedger implements BudgetStore {
  private readonly client: RpcClient;
  private readonly userId: string;
  private readonly caps: ServerCaps;
  private readonly budgetId: string | undefined;
  constructor(client: RpcClient, userId: string, caps: ServerCaps, budgetId?: string) {
    if (!userId || ![caps.sessionUsd, caps.userDayUsd, caps.globalDayUsd].every((n) => Number.isFinite(n) && n > 0)) throw new Error('');
    this.client = client; this.userId = userId; this.caps = { ...caps }; this.budgetId = budgetId;
  }
  private async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    // Only accounting fields below, never report/views/context/credentials. Supabase handles transport serialization.
    const result = await this.client.rpc(name, { p_user_id: this.userId, ...args });
    if (result.error) throw new Error('');
    return result.data;
  }
  async openBudget(): Promise<BudgetInfo> {
    const r = row(await this.call('open_judge_budget', { p_session_cap_usd: this.caps.sessionUsd,
      p_user_day_cap_usd: this.caps.userDayUsd, p_global_day_cap_usd: this.caps.globalDayUsd, p_ttl_seconds: 3600 }));
    if (typeof r.budget_id !== 'string' || typeof r.cap_usd !== 'number' || !Number.isFinite(r.cap_usd) || r.cap_usd <= 0 ||
        typeof r.expires_at !== 'string' || !Number.isFinite(Date.parse(r.expires_at))) throw new Error('');
    return { budgetId: r.budget_id, capUsd: r.cap_usd, expiresAt: r.expires_at };
  }
  async reserve(b: ReservationBinding): Promise<UsageReservation> {
    if (!this.budgetId) throw new Error('');
    return reservation(await this.call('reserve_judge_usage', { p_budget_id: this.budgetId, p_request_id: b.requestId,
      p_attempt: b.attempt, p_payload_hash: b.payloadHash, p_prompt_fingerprint: b.promptFingerprint,
      p_provider: b.provider, p_model_id: b.modelId,
      p_units: b.units, p_est_cost_usd: b.estimateUsd,
      p_user_day_cap_usd: this.caps.userDayUsd, p_global_day_cap_usd: this.caps.globalDayUsd }));
  }
  async claim(usageId: string): Promise<boolean> {
    const r = row(await this.call('claim_judge_dispatch', { p_usage_id: usageId }));
    if (r.usage_id !== usageId || typeof r.claimed !== 'boolean') throw new Error('');
    return r.claimed;
  }
  async settle(usageId: string, outcome: 'settled' | 'failed' | 'ambiguous', actualUsd?: number): Promise<void> {
    reservation(await this.call('settle_judge_usage', { p_usage_id: usageId, p_outcome: outcome,
      p_actual_cost_usd: outcome === 'settled' ? actualUsd : null }));
  }
}
