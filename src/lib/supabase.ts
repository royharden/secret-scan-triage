import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface PublicEnvironment { VITE_SUPABASE_URL?: string; VITE_SUPABASE_ANON_KEY?: string }

/** Call only from an explicit Setup/live action. Importing this module does not construct a client or start auth. */
export function getSupabaseClient(env: PublicEnvironment = import.meta.env): SupabaseClient | null {
  const url = env.VITE_SUPABASE_URL?.trim();
  const key = env.VITE_SUPABASE_ANON_KEY?.trim();
  if (!url || !key) return null;
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  } catch { return null; }
}
