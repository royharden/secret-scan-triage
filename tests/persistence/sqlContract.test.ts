// Source contract checks only. These do not execute PostgreSQL or prove concurrency/RLS behavior.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const rulings = readFileSync(new URL('../../supabase/migrations/20261101000100_rulings.sql', import.meta.url), 'utf8');
const runs = readFileSync(new URL('../../supabase/migrations/20261101000200_triage_runs.sql', import.meta.url), 'utf8');
const usage = readFileSync(new URL('../../supabase/migrations/20261101000300_judge_usage.sql', import.meta.url), 'utf8');
function body(name: string): string {
  const start = usage.indexOf(`create function public.${name}(`);
  const end = usage.indexOf('\n$$;', start);
  if (start < 0 || end < 0) throw new Error('missing SQL function');
  return usage.slice(start, end);
}

describe('unapplied SQL source contract', () => {
  it('exposes only owner append/select for rulings and closed masked run summaries', () => {
    // what_bug_this_catches: accidental update/delete privileges/policies or a free-form run payload field.
    for (const [name, sql] of [['rulings', rulings], ['triage_runs', runs]]) {
      expect(sql).toContain(`alter table public.${name} enable row level security`);
      expect(sql).toContain(`grant select on public.${name} to authenticated`);
      expect(sql).toMatch(new RegExp(`grant insert \\([^;]+on public\\.${name} to authenticated`));
      expect(sql).toContain(`revoke update, delete, truncate, references, trigger on public.${name} from public, anon, authenticated`);
      expect(sql).not.toMatch(/create policy[^;]+for (update|delete|all)/i);
      expect(sql.match(/user_id = \(select auth\.uid\(\)\)/g)).toHaveLength(2);
    }
    expect(rulings).not.toMatch(/grant insert \([^)]*created_at/);
    const columns = runs.slice(runs.indexOf('create table'), runs.indexOf('create index'));
    expect(columns).not.toMatch(/\b(path|context|raw|payload|report|value|salt)\b/i);
    expect(columns).toContain("source = 'live' or cost_usd is null");
  });
  it('restricts accounting writes to four locked service-only security-definer RPCs', () => {
    // what_bug_this_catches: PostgreSQL's default PUBLIC function execute or a client write path bypasses caps.
    expect(usage).toContain('create table public.judge_usage');
    expect(usage).not.toContain('create table public.judge_reservations');
    for (const table of ['judge_budgets', 'judge_usage']) expect(usage).toContain(`alter table public.${table} enable row level security`);
    expect(usage).toContain('revoke all on public.judge_budgets, public.judge_usage from public, anon, authenticated');
    expect(usage).toContain('grant select on public.judge_budgets, public.judge_usage to authenticated');
    for (const name of ['open_judge_budget', 'reserve_judge_usage', 'claim_judge_dispatch', 'settle_judge_usage']) {
      expect(body(name)).toContain('security definer set search_path = pg_catalog, public');
      expect(body(name)).toContain('perform pg_advisory_xact_lock(26026, 1)');
      expect(usage).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^;]+from public, anon, authenticated;`));
      expect(usage).toMatch(new RegExp(`grant execute on function public\\.${name}\\([^;]+to service_role;`));
    }
    expect(usage).not.toMatch(/grant (insert|update|delete|all)[^;]+to (anon|authenticated)/i);
  });
  it('reuses unexpired server budgets and counts all owner/day and global/day usage across budget rotation', () => {
    // what_bug_this_catches: repeated open_budget resets a session cap or daily sums only include the current budget.
    const open = body('open_judge_budget');
    expect(open).toContain("b.user_id = p_user_id and b.kind = 'session' and b.expires_at > v_now");
    expect(open).toMatch(/if not found then\s+insert into public\.judge_budgets/);
    expect(open).not.toMatch(/update public\.judge_budgets/);
    const reserve = body('reserve_judge_usage');
    expect(reserve).toContain("v_day := (v_now at time zone 'UTC')::date");
    expect(reserve).toContain('where u.user_id = p_user_id and u.day = v_day');
    expect(reserve).toContain('into v_global_used from public.judge_usage u where u.day = v_day');
    for (const cap of ['session_cap_exceeded', 'user_day_cap_exceeded', 'global_day_cap_exceeded', 'live_disabled']) expect(reserve).toContain(cap);
    expect(open).toContain('live_disabled');
  });
  it('binds duplicate attempts, claims dispatch once and retains uncertain charges', () => {
    // what_bug_this_catches: borrowing another payload's reservation, racing dispatch, or refunding ambiguous spend.
    expect(usage).toContain('unique (user_id, request_id, attempt)');
    const reserve = body('reserve_judge_usage');
    for (const field of ['budget_id', 'payload_hash', 'prompt_fingerprint', 'provider', 'model_id', 'units', 'est_cost_usd']) expect(reserve).toContain(`v_usage.${field} is distinct from p_${field}`);
    expect(reserve).toContain("case when u.status = 'settled' then u.actual_cost_usd else u.est_cost_usd end");
    const claim = body('claim_judge_dispatch');
    expect(claim).toContain("u.status = 'reserved'");
    expect(claim).toContain("u.day = (v_now at time zone 'UTC')::date");
    expect(claim).toContain('b.expires_at > v_now');
    const settle = body('settle_judge_usage');
    expect(settle).toContain('p_actual_cost_usd > v_usage.est_cost_usd');
    expect(settle).toContain("p_outcome <> 'settled' and p_actual_cost_usd is not null");
    expect(settle).toContain('settlement_conflict');
    expect(settle).toContain('dispatch_not_claimed');
  });
});
