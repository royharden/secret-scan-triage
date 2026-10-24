import { useState } from 'react';
import { getSupabaseClient } from '../../lib/supabase.ts';

/** Mounted only after the user explicitly opens Setup; missing environment configuration is a normal state. */
export function Setup({ onBack }: { onBack: () => void }) {
  const [configured] = useState(() => getSupabaseClient() !== null);
  return <section className="setup-panel" aria-labelledby="setup-heading"><span className="eyebrow">Optional / Connected mode</span><h2 id="setup-heading">Local review works without setup.</h2><p>The current construction slice uses a scripted mock judge. Live inference, authentication, cloud storage and durable budgets arrive in later milestones.</p><div className="session-notice"><strong>{configured ? 'Public client configuration is present.' : 'No valid public Supabase configuration found.'}</strong> No sign-in or network call is made by this setup check.</div><p>For later connected mode, copy <code>.env.example</code> into a local environment file and supply <code>VITE_SUPABASE_URL</code> and the public <code>VITE_SUPABASE_ANON_KEY</code>. Provider credentials and service-role keys belong on the server.</p><button className="primary" onClick={onBack}>Back to local review</button></section>;
}
