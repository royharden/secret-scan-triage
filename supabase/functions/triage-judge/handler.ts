import { serializeSafe } from './_shared/core/safe.ts';
import { makeProviderJudge } from './_shared/core/providers/factory.ts';
import { isLiveProvider } from './_shared/core/providers/serverConfig.ts';
import type { LiveProviderId, ServerProviderConfig, ServerCaps } from './_shared/core/providers/serverConfig.ts';
import { sha256Hex, stableStringify, promptFingerprint } from './_shared/core/judge/fingerprint.ts';
import type { JudgeResult, MaskedView } from './_shared/core/judge/contract.ts';
import type { BudgetStore } from './reserve.ts';
import { SERVER_MASK_GUARD, validateMaskedView, accountingResponseGuard } from './maskcheck.ts';
export interface HandlerDependencies {
  verifyUser(request: Request): Promise<{ id: string } | null>;
  createBudgetStore(verifiedUid: string, caps: ServerCaps, budgetId?: string): BudgetStore;
  getServerConfig(provider: LiveProviderId): ServerProviderConfig | null;
  getServerCaps(): ServerCaps | null;
  allowedOrigins: readonly string[];
  fetch?: typeof fetch;
}
export const MAX_BATCH_BYTES = 200 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function object(x: unknown): x is Record<string, unknown> { return typeof x === 'object' && x !== null && !Array.isArray(x); }
function keys(x: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(x).length === allowed.length && allowed.every((key) => Object.prototype.hasOwnProperty.call(x, key));
}
class RequestError extends Error { readonly status: number; constructor(status: number) { super(''); this.status = status; } }
async function requestJson(request: Request): Promise<unknown> {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BATCH_BYTES)) throw new RequestError(413);
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json') || !request.body) throw new RequestError(422);
  const reader = request.body.getReader();
  let bytes = 0;
  let body = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_BATCH_BYTES) throw new RequestError(413);
      body += decoder.decode(next.value, { stream: true });
    }
    body += decoder.decode();
    return JSON.parse(body);
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof RequestError) throw error;
    throw new RequestError(422);
  } finally { reader.releaseLock(); }
}
export function makeTriageJudgeHandler(deps: HandlerDependencies): (request: Request) => Promise<Response> {
  return async (request) => {
    const origin = request.headers.get('origin');
    const issuedIds = new Set<string>();
    const headers: Record<string, string> = { 'content-type': 'application/json', 'cache-control': 'no-store', vary: 'Origin' };
    const response = (value: unknown, status = 200): Response => {
      try { return new Response(serializeSafe(value, 'function_request', accountingResponseGuard(issuedIds)), { status, headers }); }
      catch { return new Response('{"error":"response_blocked"}', { status: 502, headers }); }
    };
    if (origin !== null && !deps.allowedOrigins.includes(origin)) return response({ error: 'origin_not_allowed' }, 403);
    if (origin !== null) headers['access-control-allow-origin'] = origin;
    if (request.method === 'OPTIONS') {
      headers['access-control-allow-methods'] = 'POST, OPTIONS';
      headers['access-control-allow-headers'] = 'authorization, content-type, apikey, x-client-info';
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== 'POST') return response({ error: 'method_not_allowed' }, 405);
    // Auth precedes reading any service credentials or constructing any service client/store. CORS is never authentication.
    let user: { id: string } | null;
    try { user = await deps.verifyUser(request); } catch { user = null; }
    if (!user?.id) return response({ error: 'unauthorized' }, 401);
    let raw: unknown;
    try { raw = await requestJson(request); }
    catch (error) { return response({ error: 'invalid_request' }, error instanceof RequestError ? error.status : 422); }
    if (!object(raw) || raw.consent !== true) return response({ error: 'consent_required' }, 422);
    const caps = deps.getServerCaps();
    if (!caps) return response({ error: 'live_not_configured' }, 503);
    if (raw.op === 'open_budget') {
      if (!keys(raw, ['op', 'consent'])) return response({ error: 'invalid_request' }, 422);
      // At least one fully configured provider is required, not merely configured caps.
      if (!(['anthropic', 'openai_compatible', 'typesafe'] as const).some((p) => deps.getServerConfig(p))) {
        return response({ error: 'provider_not_configured' }, 503);
      }
      try {
        const budget = await deps.createBudgetStore(user.id, caps).openBudget();
        if (!UUID.test(budget.budgetId)) throw new Error('');
        issuedIds.add(budget.budgetId);
        return response(budget);
      }
      catch { return response({ error: 'budget_unavailable' }, 409); }
    }
    if (raw.op !== 'judge' || !keys(raw, ['op', 'budgetId', 'requestId', 'attempt', 'consent', 'provider', 'views']) ||
        !isLiveProvider(raw.provider) || typeof raw.budgetId !== 'string' || !UUID.test(raw.budgetId) ||
        typeof raw.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(raw.requestId) || raw.attempt !== 1 ||
        !Array.isArray(raw.views) || raw.views.length < 1 || raw.views.length > 50) return response({ error: 'invalid_request' }, 422);
    if (!raw.views.every(validateMaskedView)) return response({ error: 'invalid_masked_view' }, 422);
    const config = deps.getServerConfig(raw.provider);
    if (!config) return response({ error: 'provider_not_configured' }, 503);
    const views: MaskedView[] = raw.views;
    try {
      const ledger = deps.createBudgetStore(user.id, caps, raw.budgetId);
      const fingerprint = await promptFingerprint();
      const batch = stableStringify({ views, provider: config.provider, modelId: config.modelId, fingerprint });
      const results: JudgeResult[] = [];
      // Sequential intentionally bounds concurrency to one provider call per handler invocation.
      for (let index = 0; index < views.length; index++) {
        const view = views[index]!;
        const payloadHash = await sha256Hex(`${batch}\nindex:${index}`);
        const judge = makeProviderJudge(config, { guard: SERVER_MASK_GUARD, ledger, fetch: deps.fetch,
          requestId: `${raw.requestId}:${index}`, payloadHash });
        results.push(await judge.judge(view));
      }
      return response({ results });
    } catch { return response({ error: 'judge_unavailable' }, 503); }
  };
}
