import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requestLiveJudge } from '../../src/lib/liveJudge.ts';
import { OFFLINE_CONSENT, mayUseCloud, mayUseInference } from '../../src/lib/consent.ts';
import { saveRunSummary } from '../../src/lib/cloudRuns.ts';
import { NOT_READY_GUARD, serializeSafe } from '../../src/core/safe.ts';
import { buildMaskedView } from '../../src/core/judge/views.ts';
import { guardFor, findingFor } from '../rulings/fixtures.ts';
import { readQueueItem } from '../../src/app/session.ts';
import type { Session } from '../../src/app/session.ts';

function fixture() {
  const guard = guardFor(); const finding = findingFor();
  const view = { ...buildMaskedView(finding)!, findingId: 'candidate-0' };
  const invoke = vi.fn(async (_name: string, options: { body: Record<string, unknown> }) => ({ data: options.body.op === 'open_budget'
    ? { budgetId: ['00000000', '0000', '4000', '8000', '000000000001'].join('-'), capUsd: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() }
    : { results: [{ status: 'failed', p_real: null, reason_code: 'cannot_tell', provider: 'anthropic', modelId: 'configured-fixture', usage: { calls: 1, inputTokens: 20, outputTokens: 0, usd: .01 }, usage_estimated: true }] }, error: null }));
  const getSession = vi.fn(async () => ({ data: { session: { user: { id: 'user-a' }, access_token: 'fixture-session' } }, error: null }));
  type Query = { select: (columns: string) => Query; eq: (key: string, value: string) => Query; order: (key: string, options: unknown) => Query; limit: (n: number) => Promise<{ data: unknown[]; error: null }> };
  const query: Query = { select: () => query, eq: () => query, order: () => query, limit: async () => ({ data: [], error: null }) };
  const from = vi.fn(() => query);
  const client = { auth: { getSession }, functions: { invoke }, from } as unknown as SupabaseClient;
  return { guard, finding, view, client, invoke, getSession, from };
}
describe('browser connected gates (unexecuted source contracts)', () => {
  it('sign-in does not imply cloud or inference; default mode sends no request', async () => {
    const f = fixture();
    expect(mayUseCloud(OFFLINE_CONSENT, 'user-a', true)).toBe(false);
    expect(mayUseInference(OFFLINE_CONSENT, 'user-a', true, true)).toBe(false);
    await expect(requestLiveJudge({ ...f, userId: 'user-a', consent: { ...OFFLINE_CONSENT }, enabled: true, provider: 'anthropic', views: [f.view] })).rejects.toThrow();
    await expect(saveRunSummary(f.client, 'user-a', { ...OFFLINE_CONSENT }, {} as Session, f.guard)).rejects.toThrow();
    expect(f.getSession).not.toHaveBeenCalled(); expect(f.invoke).not.toHaveBeenCalled(); expect(f.from).not.toHaveBeenCalled();
  });
  it('reload guard and consent revocation stop dispatch before the function request', async () => {
    const f = fixture(); const consent = { cloudStorage: false, liveInference: true };
    await expect(requestLiveJudge({ ...f, guard: NOT_READY_GUARD, userId: 'user-a', consent, enabled: true, provider: 'anthropic', views: [f.view] })).rejects.toThrow();
    let allowed = true;
    f.getSession.mockImplementation(async () => { allowed = false; return { data: { session: { user: { id: 'user-a' }, access_token: 'fixture-session' } }, error: null }; });
    await expect(requestLiveJudge({ ...f, userId: 'user-a', consent, enabled: true, provider: 'anthropic', views: [f.view], authorized: () => allowed })).rejects.toThrow();
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it('preserves a failed provider reply as reviewable status, not NaN text or a dropped row', async () => {
    // what_bug_this_catches: failed scores cross JSON as null and must restore non-comparable NaN without losing the row.
    const f = fixture();
    const result = await requestLiveJudge({ ...f, userId: 'user-a', consent: { cloudStorage: false, liveInference: true }, enabled: true, provider: 'anthropic', views: [f.view] });
    expect(f.invoke).toHaveBeenCalledTimes(2);
    expect(Number.isNaN(result.results[0]?.p_real)).toBe(true);
    const row = { position: 0, finding: f.finding, decision: { band: 'review', stage: 2, reasons: ['Provider unavailable'] }, human: 'pending', judge: result.results[0] };
    const restored = readQueueItem(serializeSafe(row, 'ui_state', f.guard), f.guard);
    expect(restored.decision.band).toBe('review'); expect(restored.judge?.status).toBe('failed');
    expect(restored.judge?.usage_estimated).toBe(true);
  });
});
