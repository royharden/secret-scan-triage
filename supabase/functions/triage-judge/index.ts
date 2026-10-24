// Deployment entry only. Tests import handler.ts, never Deno.serve or service secrets.
import { createClient } from 'npm:@supabase/supabase-js@2.50.3';
import { makeTriageJudgeHandler } from './handler.ts';
import { RpcCallLedger } from './reserve.ts';
import { loadServerCaps, loadServerProviderConfig } from './_shared/core/providers/serverConfig.ts';
const readSettings = (): Record<string, string | undefined> => Deno.env.toObject();
const handler = makeTriageJudgeHandler({
  allowedOrigins: (Deno.env.get('JUDGE_ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  async verifyUser(request) {
    const authorization = request.headers.get('authorization') ?? '';
    if (!/^Bearer [A-Za-z0-9._-]+$/.test(authorization)) return null;
    const url = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!url || !anonKey) return null;
    const auth = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await auth.auth.getUser(authorization.slice(7));
    return error || !data.user ? null : { id: data.user.id };
  },
  getServerCaps: () => loadServerCaps(readSettings()),
  getServerConfig: (provider) => loadServerProviderConfig(readSettings(), provider),
  createBudgetStore(verifiedUid, caps, budgetId) {
    // This callback is called only after auth.getUser succeeds. Never read this key at module initialization.
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) throw new Error('');
    return new RpcCallLedger(createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }), verifiedUid, caps, budgetId);
  },
});
Deno.serve(handler);
