import type { SupabaseClient } from '@supabase/supabase-js';
import type { ConsentState } from './consent.ts';
import { mayUseInference } from './consent.ts';
import { serializeSafe } from '../core/safe.ts';
import type { LeakGuard } from '../core/safe.ts';
import type { JudgeResult, MaskedView } from '../core/judge/contract.ts';
import { isReasonCode, MAX_VIEW_BYTES } from '../core/judge/contract.ts';
export type LiveProviderId = 'anthropic' | 'openai_compatible' | 'typesafe';
export interface Budget { budgetId: string; capUsd: number; expiresAt: string }
export interface UsageSummary { rows: number; possiblyTruncated: boolean; estimatedUsd: number; actualUsd: number; heldUsd: number }
export interface LiveResponse { results: Array<JudgeResult | null>; budget: Budget; usage: UsageSummary | null; failed: number }
const budgets = new WeakMap<SupabaseClient, { userId: string; budget: Budget }>();
function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function money(value: unknown): number | null {
  const n = typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}
async function invoke(client: SupabaseClient, userId: string, body: unknown, guard: LeakGuard, authorized: () => boolean): Promise<unknown> {
  if (!authorized()) throw new Error('');
  const encoded = serializeSafe(body, 'function_request', guard);
  if (new TextEncoder().encode(encoded).length > 200 * 1024) throw new Error('');
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError || sessionData.session?.user.id !== userId || !sessionData.session.access_token) throw new Error('');
  if (!authorized()) throw new Error('');
  const { data, error } = await client.functions.invoke('triage-judge', { body: JSON.parse(encoded), headers: { Authorization: `Bearer ${sessionData.session.access_token}` } });
  if (error) throw new Error('');
  return JSON.parse(serializeSafe(data, 'ui_state', guard)) as unknown;
}
function readResult(raw: unknown, view: MaskedView, provider: LiveProviderId): JudgeResult {
  if (!object(raw) || raw.provider !== provider || typeof raw.modelId !== 'string' || !raw.modelId || !['ok', 'failed', 'not_requested'].includes(String(raw.status)) || !isReasonCode(raw.reason_code) || !object(raw.usage)) throw new Error('');
  for (const name of ['calls', 'inputTokens', 'outputTokens', 'usd']) if (typeof raw.usage[name] !== 'number' || money(raw.usage[name]) === null) throw new Error('');
  for (const flag of ['usage_estimated', 'usage_unknown']) if (raw[flag] !== undefined && typeof raw[flag] !== 'boolean') throw new Error('');
  if (raw.status === 'ok' && (typeof raw.p_real !== 'number' || !Number.isFinite(raw.p_real) || raw.p_real < 0 || raw.p_real > 1)) throw new Error('');
  if (raw.cited_lines !== undefined && (!Array.isArray(raw.cited_lines) || raw.cited_lines.length > 7 || raw.cited_lines.some(id => typeof id !== 'string' || !view.maskedWindow.some(line => line.lineId === id)))) throw new Error('');
  if (raw.status === 'ok' && provider !== 'typesafe' && (!Array.isArray(raw.cited_lines) || raw.cited_lines.length === 0)) throw new Error('');
  if (raw.model_text !== undefined && (typeof raw.model_text !== 'string' || raw.model_text.length > 200 || raw.model_text_label !== 'model-authored')) throw new Error('');
  // Failed JSON scores are null; restore NaN so accidental comparisons never succeed.
  const clean = { provider: raw.provider, modelId: raw.modelId, status: raw.status, reason_code: raw.reason_code,
    p_real: raw.status === 'ok' ? raw.p_real : Number.NaN,
    usage: { calls: raw.usage.calls, inputTokens: raw.usage.inputTokens, outputTokens: raw.usage.outputTokens, usd: raw.usage.usd },
    ...(raw.cited_lines !== undefined ? { cited_lines: raw.cited_lines } : {}),
    ...(raw.model_text !== undefined ? { model_text: raw.model_text, model_text_label: 'model-authored' } : {}),
    ...(raw.usage_estimated === true ? { usage_estimated: true } : {}),
    ...(raw.usage_unknown === true ? { usage_unknown: true } : {}) };
  return clean as unknown as JudgeResult;
}
async function accounting(client: SupabaseClient, userId: string, budget: Budget, guard: LeakGuard): Promise<UsageSummary | null> {
  try {
    const { data, error } = await client.from('judge_usage').select('status,est_cost_usd,actual_cost_usd,provider,model_id,units')
      .eq('user_id', userId).eq('budget_id', budget.budgetId).order('created_at', { ascending: false }).limit(1000);
    if (error || !Array.isArray(data)) return null;
    const rows = JSON.parse(serializeSafe(data, 'ui_state', guard)) as Array<Record<string, unknown>>;
    let estimatedUsd = 0; let actualUsd = 0; let heldUsd = 0;
    for (const row of rows) {
      const estimated = money(row.est_cost_usd); const actual = row.actual_cost_usd === null ? null : money(row.actual_cost_usd);
      if (estimated === null || (row.actual_cost_usd !== null && actual === null)) return null;
      estimatedUsd += estimated;
      if (row.status === 'settled' && actual !== null) actualUsd += actual; else heldUsd += estimated;
    }
    if (![estimatedUsd, actualUsd, heldUsd].every(Number.isFinite)) return null;
    const summary = { rows: rows.length, possiblyTruncated: rows.length === 1000, estimatedUsd, actualUsd, heldUsd };
    serializeSafe(summary, 'ui_state', guard); return summary;
  } catch { return null; }
}
/** All gates precede even session lookup. Default/off/reloaded sessions make no function or accounting request. */
export async function requestLiveJudge(input: { client: SupabaseClient; userId: string | null; consent: ConsentState; enabled: boolean; provider: LiveProviderId; views: readonly MaskedView[]; guard: LeakGuard; authorized?: () => boolean }): Promise<LiveResponse> {
  const { client, consent, guard, provider } = input;
  if (!mayUseInference(consent, input.userId, guard.ready, input.enabled) || !input.userId) throw new Error('');
  const userId = input.userId;
  const authorized = () => mayUseInference(consent, userId, guard.ready, input.enabled) && (input.authorized?.() ?? true);
  if (!['anthropic', 'openai_compatible', 'typesafe'].includes(provider) || input.views.length > 20_000) throw new Error('');
  for (const view of input.views) if (new TextEncoder().encode(serializeSafe(view, 'function_request', guard)).length > MAX_VIEW_BYTES) throw new Error('');
  const old = budgets.get(client);
  let budget = old?.userId === userId && Date.parse(old.budget.expiresAt) > Date.now() ? old.budget : null;
  if (!budget) {
    const opened = await invoke(client, userId, { op: 'open_budget', consent: true }, guard, authorized);
    if (!object(opened) || typeof opened.budgetId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(opened.budgetId) || (money(opened.capUsd) ?? 0) <= 0 || typeof opened.expiresAt !== 'string' || !(Date.parse(opened.expiresAt) > Date.now())) throw new Error('');
    budget = { budgetId: opened.budgetId, capUsd: money(opened.capUsd)!, expiresAt: opened.expiresAt };
    budgets.set(client, { userId, budget });
  }
  const results: Array<JudgeResult | null> = Array(input.views.length).fill(null);
  for (let offset = 0; offset < input.views.length;) {
    const requestId = globalThis.crypto.randomUUID();
    let count = Math.min(50, input.views.length - offset);
    const bodyFor = (n: number) => ({ op: 'judge', budgetId: budget!.budgetId, requestId, attempt: 1, consent: true, provider, views: input.views.slice(offset, offset + n) });
    while (count > 1 && new TextEncoder().encode(serializeSafe(bodyFor(count), 'function_request', guard)).length > 200 * 1024) count--;
    try {
      const response = await invoke(client, userId, bodyFor(count), guard, authorized);
      if (!object(response) || !Array.isArray(response.results) || response.results.length !== count) throw new Error('');
      for (let i = 0; i < count; i++) results[offset + i] = readResult(response.results[i], input.views[offset + i], provider);
      offset += count;
    } catch { break; } // Earlier results remain available. Ambiguous attempts may retain authoritative reservations.
  }
  let usage = authorized() ? await accounting(client, userId, budget, guard) : null;
  const returnedCost = results.reduce((sum, result) => sum + (result?.usage.usd ?? 0), 0);
  if (usage && !usage.possiblyTruncated && usage.actualUsd + usage.heldUsd + 1e-9 < returnedCost) usage = null;
  return { results, budget, usage, failed: results.filter(result => result === null).length };
}
