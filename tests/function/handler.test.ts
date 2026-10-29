// Handler fake tests are construction source, NOT database/concurrency acceptance evidence.
import { describe, expect, it, vi } from 'vitest';
import { makeTriageJudgeHandler, MAX_BATCH_BYTES } from '../../supabase/functions/triage-judge/handler.ts';
import type { HandlerDependencies } from '../../supabase/functions/triage-judge/handler.ts';
import { MemoryCallLedger } from '../../src/core/ledger/callledger.ts';
import { config, judgment, response, view } from '../providers/helpers.ts';
const BUDGET = '11111111-1111-4111-8111-111111111111';
const OTHER_BUDGET = '22222222-2222-4222-8222-222222222222';
const owner = '33333333-3333-4333-8333-333333333333';
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { op: 'judge', budgetId: BUDGET, requestId: 'handler-request', attempt: 1, consent: true,
    provider: 'anthropic', views: [view()], ...overrides };
}
function request(body: unknown, origin = 'https://app.example'): Request {
  return new Request('https://function.example/triage-judge', { method: 'POST', headers: {
    authorization: 'Bearer test-placeholder', 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
}
function setup(capUsd = 1) {
  const ledger = new MemoryCallLedger({ capUsd });
  const store = { reserve: ledger.reserve.bind(ledger), claim: ledger.claim.bind(ledger), settle: ledger.settle.bind(ledger),
    openBudget: vi.fn(async () => ({ budgetId: BUDGET, capUsd, expiresAt: '2026-10-24T23:00:00Z' })) };
  const fetcher = vi.fn(async () => response(judgment)) as unknown as typeof fetch;
  const deps: HandlerDependencies = { allowedOrigins: ['https://app.example'], verifyUser: vi.fn(async () => ({ id: owner })),
    createBudgetStore: vi.fn(() => store), getServerCaps: () => ({ sessionUsd: capUsd, userDayUsd: capUsd, globalDayUsd: 10 }),
    getServerConfig: () => config(), fetch: fetcher };
  return { ledger, store, deps, fetcher };
}
describe('authenticated triage-judge source contract', () => {
  it('verifies JWT before service store creation; anon key/allowed origin is insufficient', async () => {
    const s = setup(); s.deps.verifyUser = vi.fn(async () => null);
    const result = await makeTriageJudgeHandler(s.deps)(request({ op: 'open_budget', consent: true }));
    expect(result.status).toBe(401); expect(s.deps.createBudgetStore).not.toHaveBeenCalled(); expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('uses only verified owner and server caps, rejects supplied owner/caps/model', async () => {
    const s = setup(); const handler = makeTriageJudgeHandler(s.deps);
    expect((await handler(request({ op: 'open_budget', consent: true }))).status).toBe(200);
    expect(s.deps.createBudgetStore).toHaveBeenCalledWith(owner, { sessionUsd: 1, userDayUsd: 1, globalDayUsd: 10 });
    for (const addition of [{ userId: 'other' }, { capUsd: 100 }, { modelId: 'client-model' }]) {
      expect((await handler(request(payload(addition)))).status).toBe(422);
    }
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('disables live with no consent, unset daily caps, or missing provider settings', async () => {
    const s = setup();
    expect((await makeTriageJudgeHandler(s.deps)(request(payload({ consent: false })))).status).toBe(422);
    s.deps.getServerCaps = () => null;
    expect((await makeTriageJudgeHandler(s.deps)(request(payload()))).status).toBe(503);
    s.deps.getServerCaps = () => ({ sessionUsd: 1, userDayUsd: 1, globalDayUsd: 10 });
    s.deps.getServerConfig = () => null;
    expect((await makeTriageJudgeHandler(s.deps)(request(payload()))).status).toBe(503);
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('rejects unknown fields, unmasked generic/provider tokens, invalid view schema and caller retry numbers', async () => {
    const s = setup(); const handler = makeTriageJudgeHandler(s.deps);
    const leaked = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6'].join('');
    const badViews = [{ ...view(), path: 'private/full/path' }, { ...view(), scannerVerified: 'false' },
      { ...view(), maskedLine: leaked, maskedWindow: [{ lineId: 'L0', text: leaked }] },
      { ...view(), signalBuckets: ['S-R99:real:strong'] }, { ...view(), basename: '../private.ts' }];
    for (const bad of badViews) expect((await handler(request(payload({ views: [bad] })))).status).toBe(422);
    expect((await handler(request(payload({ attempt: 2 })))).status).toBe(422);
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('enforces batch count, each 4KiB view and total streamed 200KiB without trusting Content-Length', async () => {
    const s = setup(); const handler = makeTriageJudgeHandler(s.deps);
    expect((await handler(request(payload({ views: Array.from({ length: 51 }, view) })))).status).toBe(422);
    expect((await handler(request(payload({ views: [{ ...view(), maskedLine: 'x'.repeat(4097) }] })))).status).toBe(422);
    const large = request({ padding: 'x'.repeat(MAX_BATCH_BYTES) });
    expect((await handler(large)).status).toBe(413);
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('repeated open reuses a fake durable budget and new request/budget cannot reset shared daily charge', async () => {
    const s = setup(0.04);
    s.deps.fetch = vi.fn(async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    const handler = makeTriageJudgeHandler(s.deps);
    const first = await (await handler(request({ op: 'open_budget', consent: true }))).json();
    expect((await (await handler(request({ op: 'open_budget', consent: true }))).json()).budgetId).toBe(first.budgetId);
    const initial = await (await handler(request(payload()))).json();
    expect(initial.results[0].usage_estimated).toBe(true);
    const charge = s.ledger.chargedUsd;
    const later = await (await handler(request(payload({ budgetId: OTHER_BUDGET, requestId: 'new-request' })))).json();
    expect(later.results[0].status).toBe('failed'); expect(s.deps.fetch).toHaveBeenCalledTimes(1);
    expect(s.ledger.chargedUsd).toBe(charge);
  });
  it('concurrent duplicate payload dispatches once, changed payload cannot borrow prior reservation', async () => {
    const s = setup(); const handler = makeTriageJudgeHandler(s.deps);
    const results = await Promise.all([handler(request(payload())), handler(request(payload()))]);
    expect(results.every((r) => r.status === 200)).toBe(true); expect(s.fetcher).toHaveBeenCalledTimes(1);
    const changed = { ...view(), ruleId: 'different-rule' };
    const changedResult = await (await handler(request(payload({ views: [changed] })))).json();
    expect(changedResult.results[0].status).toBe('failed'); expect(s.fetcher).toHaveBeenCalledTimes(1);
  });
  it('CORS preflight is allowlisted and never creates authenticated accounting', async () => {
    const s = setup(); const handler = makeTriageJudgeHandler(s.deps);
    const rejected = await handler(request(payload(), 'https://untrusted.example'));
    expect(rejected.status).toBe(403); expect(s.deps.verifyUser).not.toHaveBeenCalled();
    const preflight = await handler(new Request('https://function.example', { method: 'OPTIONS', headers: { origin: 'https://app.example' } }));
    expect(preflight.status).toBe(204); expect(s.deps.createBudgetStore).not.toHaveBeenCalled();
  });
});
