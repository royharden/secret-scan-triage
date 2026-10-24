/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LIVE_JUDGE_ENABLED?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
}
