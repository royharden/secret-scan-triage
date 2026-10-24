-- Closed summary schema: no free-form report JSON, paths, source lines, values or identity salts.
create table public.triage_runs (
  run_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_key text not null check (char_length(project_key) between 1 and 256),
  source text not null check (source in ('scripted-mock', 'live', 'replay')),
  scanner text not null check (scanner in ('gitleaks', 'trufflehog')),
  finding_count integer not null check (finding_count >= 0),
  keep_count integer not null check (keep_count >= 0),
  review_count integer not null check (review_count >= 0),
  dismiss_count integer not null check (dismiss_count >= 0),
  thresholds_source text not null check (thresholds_source in ('untuned-default', 'dev-tuned')),
  prompt_fingerprint text check (prompt_fingerprint is null or prompt_fingerprint ~ '^[0-9a-f]{64}$'),
  -- NULL is unmeasured. Mock/replayed rows cannot claim measured live spend.
  cost_usd numeric check (cost_usd is null or (cost_usd >= 0 and cost_usd::text not in ('NaN', 'Infinity', '-Infinity'))),
  created_at timestamptz not null default now(),
  check (keep_count::bigint + review_count::bigint + dismiss_count::bigint = finding_count::bigint),
  check (source = 'live' or cost_usd is null)
);
create index triage_runs_owner_project on public.triage_runs (user_id, project_key, created_at);
alter table public.triage_runs enable row level security;
revoke all on public.triage_runs from public, anon, authenticated;
grant select on public.triage_runs to authenticated;
grant insert (user_id, project_key, source, scanner, finding_count, keep_count, review_count, dismiss_count, thresholds_source, prompt_fingerprint, cost_usd)
  on public.triage_runs to authenticated;
revoke update, delete, truncate, references, trigger on public.triage_runs from public, anon, authenticated;
create policy triage_runs_owner_select on public.triage_runs for select to authenticated using (user_id = (select auth.uid()));
create policy triage_runs_owner_insert on public.triage_runs for insert to authenticated with check (user_id = (select auth.uid()));
