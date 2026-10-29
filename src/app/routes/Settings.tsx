import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../../lib/supabase.ts';
import { CLOUD_NOTICE, inferenceNotice } from '../../lib/consent.ts';
import type { ConsentState } from '../../lib/consent.ts';
export type LiveProvider = 'anthropic' | 'openai_compatible' | 'typesafe';
export interface Connection { client: SupabaseClient; userId: string | null }
interface Props {
  onConnection: (connection: Connection) => void;
  consent: ConsentState;
  onConsent: (consent: ConsentState) => void;
  provider: LiveProvider;
  onProvider: (provider: LiveProvider) => void;
  liveEnabled: boolean;
}
export function Settings({ onConnection, consent, onConsent, provider, onProvider, liveEnabled }: Props) {
  const [client] = useState(() => getSupabaseClient());
  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!client) return;
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      const id = session?.user.id ?? null; setUserId(id); onConnection({ client, userId: id });
    });
    return () => data.subscription.unsubscribe();
  }, [client, onConnection]);
  async function account(action: 'sign-in' | 'sign-up' | 'recovery' | 'update' | 'logout' | 'callback') {
    if (!client || busy) return;
    setBusy(true); setNotice('');
    try {
      let error: unknown = null;
      const redirectTo = new URL(window.location.pathname, window.location.origin).href;
      if (action === 'sign-in') ({ error } = await client.auth.signInWithPassword({ email, password }));
      else if (action === 'sign-up') ({ error } = await client.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo } }));
      else if (action === 'recovery') ({ error } = await client.auth.resetPasswordForEmail(email, { redirectTo }));
      else if (action === 'update') ({ error } = await client.auth.updateUser({ password }));
      else if (action === 'logout') ({ error } = await client.auth.signOut());
      else {
        const url = new URL(window.location.href); const hash = new URLSearchParams(url.hash.slice(1));
        const access_token = hash.get('access_token'); const refresh_token = hash.get('refresh_token'); const code = url.searchParams.get('code');
        // Remove callback credentials from the address bar; never display or log them.
        window.history.replaceState(null, '', url.pathname);
        if (access_token && refresh_token) ({ error } = await client.auth.setSession({ access_token, refresh_token }));
        else if (code) ({ error } = await client.auth.exchangeCodeForSession(code));
        else throw new Error('');
      }
      if (error) throw new Error('');
      setNotice(action === 'recovery' || action === 'sign-up' ? 'Check your email if a confirmation or recovery message is required. Finish its link here, then set a new password if recovering.' : 'Account action completed. Sign-in grants neither cloud storage nor inference consent.');
    } catch { setNotice('Account action could not complete. Check the auth configuration and email redirect allowlist, then retry.'); }
    finally { setBusy(false); setPassword(''); }
  }
  if (!client) return <div className="session-notice">No valid public backend configuration found. Local review works without an account. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY later; no server credentials belong in browser configuration.</div>;
  return <>
    <section aria-labelledby="account-heading"><h3 id="account-heading">Email account</h3><p>{userId ? 'Signed in. Consent remains separate.' : 'Signed out. Live calls require a user session.'}</p>
      <label htmlFor="auth-email">Email</label><input id="auth-email" type="email" autoComplete="email" value={email} disabled={busy} onChange={event => setEmail(event.target.value)} />
      <label htmlFor="auth-password">Password / new recovery password</label><input id="auth-password" type="password" autoComplete="current-password" value={password} disabled={busy} onChange={event => setPassword(event.target.value)} />
      <div className="finding-actions"><button disabled={busy || !email || !password} onClick={() => { void account('sign-in'); }}>Sign in</button><button disabled={busy || !email || !password} onClick={() => { void account('sign-up'); }}>Create account</button><button disabled={busy || !email} onClick={() => { void account('recovery'); }}>Send recovery email</button><button disabled={busy} onClick={() => { void account('callback'); }}>Finish email link</button><button disabled={busy || !userId || !password} onClick={() => { void account('update'); }}>Set new password</button><button disabled={busy || !userId} onClick={() => { void account('logout'); }}>Sign out</button></div>
      {notice && <p role="status">{notice}</p>}
    </section>
    <section aria-labelledby="consent-heading"><h3 id="consent-heading">Choose what may leave the device</h3><p>Both choices start off and last only for this browser session. Sign-out resets them. Re-import after a mode change or reload before protected actions.</p>
      <label className="checkbox-label"><input type="checkbox" checked={consent.cloudStorage} disabled={!userId} onChange={event => onConsent({ ...consent, cloudStorage: event.target.checked })} />Store rulings and summaries in my account</label><p className="field-hint">{CLOUD_NOTICE}</p>
      <label htmlFor="live-provider">Inference provider (server-configured models)</label><select id="live-provider" value={provider} onChange={event => onProvider(event.target.value as LiveProvider)}><option value="anthropic">Anthropic</option><option value="openai_compatible">OpenAI compatible</option><option value="typesafe">TypeSafe Jev (experimental, not promoted)</option></select>
      <label className="checkbox-label"><input type="checkbox" checked={consent.liveInference} disabled={!userId || !liveEnabled} onChange={event => onConsent({ ...consent, liveInference: event.target.checked })} />Allow live inference and required accounting</label><p className="field-hint">{inferenceNotice(provider)}</p>
      {!liveEnabled && <p>Live inference is disabled by the public VITE_LIVE_JUDGE_ENABLED flag. Provider keys, model prices and server caps are also required later.</p>}
    </section>
  </>;
}
