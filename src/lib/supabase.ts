import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

let cached: { url: string; key: string; client: SupabaseClient } | undefined;

export interface PublicEnvironment { VITE_SUPABASE_URL?: string; VITE_SUPABASE_ANON_KEY?: string }

/** Call only from an explicit Setup/live action. Importing this module does not construct a client or start auth. */
export function getSupabaseClient(env: PublicEnvironment = import.meta.env): SupabaseClient | null {
  const url = env.VITE_SUPABASE_URL?.trim();
  const key = env.VITE_SUPABASE_ANON_KEY?.trim();
  if (!url || !key) return null;
  try {
    const parsed = new URL(url);
    const localHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if ((parsed.protocol !== 'https:' && !localHttp) || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    if (cached?.url === url && cached.key === key) return cached.client;
    const client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    cached = { url, key, client };
    return client;
  } catch { return null; }
}
