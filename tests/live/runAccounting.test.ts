import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beginRunLive, finishRunLive, measuredRunCost, recordRunLive } from '../../src/lib/runAccounting.ts';
import type { RunLiveAccounting } from '../../src/lib/runAccounting.ts';
import { saveRunSummary } from '../../src/lib/cloudRuns.ts';
import { failedResult } from '../../src/core/judge/contract.ts';
import type { JudgeResult } from '../../src/core/judge/contract.ts';
import type { Session } from '../../src/app/session.ts';
import { findingFor, guardFor, scope } from '../rulings/fixtures.ts';

function result(usd = .01): JudgeResult {
  return failedResult('anthropic', 'fixture-live-model', 'invalid_output', { calls: 1, inputTokens: 10, outputTokens: 5, usd });
}
function complete(previous: RunLiveAccounting | undefined, reply: JudgeResult | null): RunLiveAccounting {
  return finishRunLive(recordRunLive(beginRunLive(previous), [reply], reply ? 0 : 1, 1), true);
}
function session(accounting?: RunLiveAccounting, allBlocked = false): Session {
  return { items: allBlocked ? [] : [
    { position: 0, finding: findingFor(), decision: { band: 'keep', stage: 1, reasons: [] }, human: 'pending', judge: null },
    { position: 1, finding: findingFor({ id: 'finding-b' }), decision: { band: 'dismiss', stage: 1, reasons: [] }, human: 'pending', judge: null },
  ], blocked: allBlocked ? 3 : 1, candidates: 3, format: 'gitleaks', demo: false, scope,
  thresholdsSource: 'untuned-default', liveAccounting: accounting };
}
function clientFixture() {
  const payloads: Array<Record<string, unknown>> = [];
  const insert = vi.fn(async (payload: Record<string, unknown>) => { payloads.push(structuredClone(payload)); return { error: null }; });
  const from = vi.fn((_table: string) => ({ insert }));
  return { client: { from } as unknown as SupabaseClient, from, payloads };
}
describe('per-import accumulated actual live accounting and exact cloud summary (unexecuted)', () => {
  it('sums two successful actions and inserts only the closed run-scoped actual cost/counts', async () => {
    // what_bug_this_catches: runLive overwrote the first .01 charge with the second .01 charge.
    const accounting = complete(complete(undefined, result()), result());
    expect(accounting.actions).toBe(2);
    expect(measuredRunCost(accounting)).toBeCloseTo(.02);
    const fake = clientFixture();
    await saveRunSummary(fake.client, scope.ownerId, { cloudStorage: true, liveInference: false }, session(accounting), guardFor());
    expect(fake.from).toHaveBeenCalledWith('triage_runs');
    const payload = fake.payloads[0];
    expect(Object.keys(payload).sort()).toEqual(['user_id', 'project_key', 'source', 'scanner', 'finding_count', 'keep_count',
      'review_count', 'dismiss_count', 'thresholds_source', 'prompt_fingerprint', 'cost_usd'].sort());
    expect(payload).toMatchObject({ user_id: scope.ownerId, project_key: scope.projectKey, source: 'live', scanner: 'gitleaks',
      finding_count: 3, keep_count: 1, review_count: 1, dismiss_count: 1, thresholds_source: 'untuned-default' });
    expect(payload.cost_usd).toBeCloseTo(.02);
    expect(payload.prompt_fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
  it('unknown then actual, estimate then actual, partial, catch and pending/revoked actions can never become measured', async () => {
    // what_bug_this_catches: a later known reply reset earlier uncertainty, or a reservation estimate became measured spend.
    const uncertain = [
      complete(undefined, null),
      complete(undefined, { ...result(.04), usage_estimated: true }),
      complete(undefined, { ...result(), usage_unknown: true }),
      finishRunLive(recordRunLive(beginRunLive(), [result(), null], 1, 2), true),
      finishRunLive(beginRunLive(), false),
      recordRunLive(beginRunLive(), [result()], 0, 1), // reply arrived, but consent/guard/cohort completion did not finish
    ];
    for (const earlier of uncertain) {
      const later = complete(earlier, result());
      expect(measuredRunCost(later)).toBeNull();
      const fake = clientFixture();
      await saveRunSummary(fake.client, scope.ownerId, { cloudStorage: true, liveInference: false }, session(later), guardFor());
      expect(fake.payloads[0]).toMatchObject({ source: 'live', cost_usd: null });
    }
    const freshImport = complete(undefined, result());
    expect(freshImport.actions).toBe(1);
    expect(measuredRunCost(freshImport)).toBe(.01);
  });
  it('all-null/blocked results retain live attempt source and null cost without visible live rows', async () => {
    const accounting = complete(undefined, null);
    const fake = clientFixture();
    await saveRunSummary(fake.client, scope.ownerId, { cloudStorage: true, liveInference: false }, session(accounting, true), guardFor());
    expect(fake.payloads[0]).toMatchObject({ source: 'live', cost_usd: null, finding_count: 3, keep_count: 0, review_count: 3, dismiss_count: 0 });
    const offline = clientFixture();
    await saveRunSummary(offline.client, scope.ownerId, { cloudStorage: true, liveInference: false }, session(), guardFor());
    expect(offline.payloads[0]).toMatchObject({ source: 'scripted-mock', cost_usd: null });
  });
});
