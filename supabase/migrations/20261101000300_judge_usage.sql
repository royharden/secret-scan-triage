-- Service-only reservation state. No views, report text, paths, notes, values or provider response text.
create table public.judge_budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'session' check (kind = 'session'),
  cap_usd numeric not null check (cap_usd > 0 and cap_usd::text not in ('NaN', 'Infinity', '-Infinity')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  check (expires_at > created_at)
);
create index judge_budgets_active_owner on public.judge_budgets (user_id, expires_at);

create table public.judge_usage (
  usage_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  budget_id uuid not null,
  request_id text not null check (request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  attempt integer not null check (attempt in (1, 2)),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  prompt_fingerprint text not null check (prompt_fingerprint ~ '^[0-9a-f]{64}$'),
  provider text not null check (provider in ('anthropic', 'openai_compatible', 'typesafe')),
  model_id text not null check (model_id ~ '^[A-Za-z0-9._:/-]{1,160}$'),
  day date not null,
  units integer not null check (units between 1 and 50),
  est_cost_usd numeric not null check (est_cost_usd > 0 and est_cost_usd::text not in ('NaN', 'Infinity', '-Infinity')),
  actual_cost_usd numeric check (actual_cost_usd >= 0 and actual_cost_usd <= est_cost_usd and actual_cost_usd::text not in ('NaN', 'Infinity', '-Infinity')),
  status text not null default 'reserved' check (status in ('reserved', 'dispatching', 'settled', 'failed', 'ambiguous')),
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  settled_at timestamptz,
  unique (user_id, request_id, attempt),
  foreign key (budget_id, user_id) references public.judge_budgets(id, user_id),
  check ((status = 'settled' and actual_cost_usd is not null) or (status <> 'settled' and actual_cost_usd is null))
);
create index judge_usage_user_day on public.judge_usage (user_id, day);
create index judge_usage_day on public.judge_usage (day);
create index judge_usage_budget on public.judge_usage (budget_id);
alter table public.judge_budgets enable row level security;
alter table public.judge_usage enable row level security;
revoke all on public.judge_budgets, public.judge_usage from public, anon, authenticated;
grant select on public.judge_budgets, public.judge_usage to authenticated;
-- No end-user INSERT/UPDATE/DELETE policies or privileges. Sign-in alone never authorizes inference.
create policy judge_budgets_owner_select on public.judge_budgets for select to authenticated using (user_id = (select auth.uid()));
create policy judge_usage_owner_select on public.judge_usage for select to authenticated using (user_id = (select auth.uid()));

create function public.open_judge_budget(
  p_user_id uuid, p_session_cap_usd numeric, p_user_day_cap_usd numeric, p_global_day_cap_usd numeric,
  p_ttl_seconds integer default 3600
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_budget public.judge_budgets%rowtype;
  v_now timestamptz;
begin
  -- Same transaction-scoped lock in every mutating RPC: protects all aggregate caps and state transitions.
  perform pg_advisory_xact_lock(26026, 1);
  v_now := clock_timestamp();
  if p_user_id is null or p_session_cap_usd is null or p_session_cap_usd <= 0 or
    p_session_cap_usd::text in ('NaN', 'Infinity', '-Infinity') or
    p_user_day_cap_usd is null or p_user_day_cap_usd <= 0 or p_user_day_cap_usd::text in ('NaN', 'Infinity', '-Infinity') or
    p_global_day_cap_usd is null or p_global_day_cap_usd <= 0 or p_global_day_cap_usd::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception using errcode = 'P0001', message = 'live_disabled';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds < 60 or p_ttl_seconds > 86400 then
    raise exception using errcode = 'P0001', message = 'invalid_budget_ttl';
  end if;
  -- Reopening cannot reset the server-issued session cap or extend the original expiry.
  select b.* into v_budget from public.judge_budgets b
    where b.user_id = p_user_id and b.kind = 'session' and b.expires_at > v_now
    order by b.created_at, b.id limit 1;
  if not found then
    insert into public.judge_budgets (user_id, kind, cap_usd, expires_at, created_at)
      values (p_user_id, 'session', p_session_cap_usd, v_now + make_interval(secs => p_ttl_seconds), v_now)
      returning * into v_budget;
  end if;
  return jsonb_build_object('budget_id', v_budget.id, 'cap_usd', v_budget.cap_usd, 'expires_at', v_budget.expires_at);
end;
$$;

create function public.reserve_judge_usage(
  p_user_id uuid, p_budget_id uuid, p_request_id text, p_attempt integer, p_payload_hash text, p_prompt_fingerprint text,
  p_provider text, p_model_id text, p_units integer, p_est_cost_usd numeric,
  p_user_day_cap_usd numeric, p_global_day_cap_usd numeric
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_budget public.judge_budgets%rowtype;
  v_usage public.judge_usage%rowtype;
  v_now timestamptz;
  v_day date;
  v_budget_used numeric;
  v_user_used numeric;
  v_global_used numeric;
begin
  perform pg_advisory_xact_lock(26026, 1);
  v_now := clock_timestamp();
  v_day := (v_now at time zone 'UTC')::date;
  if p_user_day_cap_usd is null or p_user_day_cap_usd <= 0 or p_user_day_cap_usd::text in ('NaN', 'Infinity', '-Infinity') or
    p_global_day_cap_usd is null or p_global_day_cap_usd <= 0 or p_global_day_cap_usd::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception using errcode = 'P0001', message = 'live_disabled';
  end if;
  if p_user_id is null or p_budget_id is null or p_request_id is null or p_request_id !~ '^[A-Za-z0-9._:-]{1,128}$' or
    p_attempt is null or p_attempt not in (1, 2) or p_payload_hash is null or p_payload_hash !~ '^[0-9a-f]{64}$' or
    p_prompt_fingerprint is null or p_prompt_fingerprint !~ '^[0-9a-f]{64}$' or
    p_provider is null or p_provider not in ('anthropic', 'openai_compatible', 'typesafe') or
    p_model_id is null or p_model_id !~ '^[A-Za-z0-9._:/-]{1,160}$' or p_units is null or p_units not between 1 and 50 or
    p_est_cost_usd is null or p_est_cost_usd <= 0 or p_est_cost_usd::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception using errcode = 'P0001', message = 'invalid_reservation';
  end if;
  select b.* into v_budget from public.judge_budgets b where b.id = p_budget_id and b.user_id = p_user_id;
  if not found or v_budget.expires_at <= v_now then
    raise exception using errcode = 'P0001', message = 'budget_unavailable';
  end if;
  select u.* into v_usage from public.judge_usage u
    where u.user_id = p_user_id and u.request_id = p_request_id and u.attempt = p_attempt;
  if found then
    if v_usage.budget_id is distinct from p_budget_id or v_usage.payload_hash is distinct from p_payload_hash or
      v_usage.prompt_fingerprint is distinct from p_prompt_fingerprint or
      v_usage.provider is distinct from p_provider or v_usage.model_id is distinct from p_model_id or
      v_usage.units is distinct from p_units or v_usage.est_cost_usd is distinct from p_est_cost_usd then
      raise exception using errcode = 'P0001', message = 'reservation_binding_mismatch';
    end if;
  else
    -- Every non-settled attempt remains charged at its worst-case estimate, including failed/ambiguous dispatches.
    select coalesce(sum(case when u.status = 'settled' then u.actual_cost_usd else u.est_cost_usd end), 0)
      into v_budget_used from public.judge_usage u where u.budget_id = p_budget_id;
    select coalesce(sum(case when u.status = 'settled' then u.actual_cost_usd else u.est_cost_usd end), 0)
      into v_user_used from public.judge_usage u where u.user_id = p_user_id and u.day = v_day;
    select coalesce(sum(case when u.status = 'settled' then u.actual_cost_usd else u.est_cost_usd end), 0)
      into v_global_used from public.judge_usage u where u.day = v_day;
    if v_budget_used + p_est_cost_usd > v_budget.cap_usd then
      raise exception using errcode = 'P0001', message = 'session_cap_exceeded';
    end if;
    if v_user_used + p_est_cost_usd > p_user_day_cap_usd then
      raise exception using errcode = 'P0001', message = 'user_day_cap_exceeded';
    end if;
    if v_global_used + p_est_cost_usd > p_global_day_cap_usd then
      raise exception using errcode = 'P0001', message = 'global_day_cap_exceeded';
    end if;
    insert into public.judge_usage (user_id, budget_id, request_id, attempt, payload_hash, prompt_fingerprint, provider, model_id, day, units, est_cost_usd, created_at)
      values (p_user_id, p_budget_id, p_request_id, p_attempt, p_payload_hash, p_prompt_fingerprint, p_provider, p_model_id, v_day, p_units, p_est_cost_usd, v_now)
      returning * into v_usage;
  end if;
  return jsonb_build_object('usage_id', v_usage.usage_id, 'status', v_usage.status, 'est_cost_usd', v_usage.est_cost_usd, 'actual_cost_usd', v_usage.actual_cost_usd);
end;
$$;

create function public.claim_judge_dispatch(p_user_id uuid, p_usage_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_usage public.judge_usage%rowtype;
  v_now timestamptz;
  v_claimed boolean := false;
begin
  perform pg_advisory_xact_lock(26026, 1);
  v_now := clock_timestamp();
  -- The WHERE transition is atomic even under a duplicate handler dispatch.
  update public.judge_usage u set status = 'dispatching', claimed_at = v_now
    where u.usage_id = p_usage_id and u.user_id = p_user_id and u.status = 'reserved'
      and u.day = (v_now at time zone 'UTC')::date
      and exists (select 1 from public.judge_budgets b where b.id = u.budget_id and b.user_id = p_user_id and b.expires_at > v_now)
    returning u.* into v_usage;
  if found then v_claimed := true;
  else
    select u.* into v_usage from public.judge_usage u where u.usage_id = p_usage_id and u.user_id = p_user_id;
    if not found then raise exception using errcode = 'P0001', message = 'reservation_unavailable'; end if;
  end if;
  return jsonb_build_object('usage_id', v_usage.usage_id, 'status', v_usage.status, 'claimed', v_claimed);
end;
$$;

create function public.settle_judge_usage(p_user_id uuid, p_usage_id uuid, p_outcome text, p_actual_cost_usd numeric default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_usage public.judge_usage%rowtype;
begin
  perform pg_advisory_xact_lock(26026, 1);
  select u.* into v_usage from public.judge_usage u where u.usage_id = p_usage_id and u.user_id = p_user_id;
  if not found then raise exception using errcode = 'P0001', message = 'reservation_unavailable'; end if;
  if p_outcome is null or p_outcome not in ('settled', 'failed', 'ambiguous') then
    raise exception using errcode = 'P0001', message = 'invalid_settlement';
  end if;
  if (p_outcome = 'settled' and (p_actual_cost_usd is null or p_actual_cost_usd < 0 or p_actual_cost_usd > v_usage.est_cost_usd or
      p_actual_cost_usd::text in ('NaN', 'Infinity', '-Infinity'))) or
    (p_outcome <> 'settled' and p_actual_cost_usd is not null) then
    raise exception using errcode = 'P0001', message = 'invalid_settlement';
  end if;
  if v_usage.status in ('settled', 'failed', 'ambiguous') then
    if v_usage.status is distinct from p_outcome or v_usage.actual_cost_usd is distinct from p_actual_cost_usd then
      raise exception using errcode = 'P0001', message = 'settlement_conflict';
    end if;
  elsif v_usage.status <> 'dispatching' then
    raise exception using errcode = 'P0001', message = 'dispatch_not_claimed';
  else
    update public.judge_usage set status = p_outcome, actual_cost_usd = p_actual_cost_usd, settled_at = clock_timestamp()
      where usage_id = p_usage_id and user_id = p_user_id and status = 'dispatching' returning * into v_usage;
  end if;
  return jsonb_build_object('usage_id', v_usage.usage_id, 'status', v_usage.status, 'est_cost_usd', v_usage.est_cost_usd, 'actual_cost_usd', v_usage.actual_cost_usd);
end;
$$;

-- PostgreSQL grants new functions EXECUTE to PUBLIC by default; remove that before authorizing the service role.
revoke all on function public.open_judge_budget(uuid, numeric, numeric, numeric, integer) from public, anon, authenticated;
revoke all on function public.reserve_judge_usage(uuid, uuid, text, integer, text, text, text, text, integer, numeric, numeric, numeric) from public, anon, authenticated;
revoke all on function public.claim_judge_dispatch(uuid, uuid) from public, anon, authenticated;
revoke all on function public.settle_judge_usage(uuid, uuid, text, numeric) from public, anon, authenticated;
grant execute on function public.open_judge_budget(uuid, numeric, numeric, numeric, integer) to service_role;
grant execute on function public.reserve_judge_usage(uuid, uuid, text, integer, text, text, text, text, integer, numeric, numeric, numeric) to service_role;
grant execute on function public.claim_judge_dispatch(uuid, uuid) to service_role;
grant execute on function public.settle_judge_usage(uuid, uuid, text, numeric) to service_role;
