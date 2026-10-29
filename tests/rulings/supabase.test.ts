import { describe, expect, it } from 'vitest';
import { RULINGS_COLUMNS, SupabaseRulingsStore } from '../../src/core/rulings/supabase.ts';
import type { CloudRulingsAuthorization, RulingCloudInsert, RulingsCloudResult, RulingsCloudSelect, RulingsCloudTable, StructuralSupabaseClient } from '../../src/core/rulings/supabase.ts';
import { LeakGuardError, NOT_READY_GUARD } from '../../src/core/safe.ts';
import { draftFor, findingFor, guardFor, scope } from './fixtures.ts';
import { defineRulingsStoreContract } from './storeContract.ts';
import { LOCAL_SCOPE, mapCloudFindingIds, prepareJourney, rulingDraft } from '../../src/app/journey.ts';
import type { Session } from '../../src/app/session.ts';
import { exportGitleaksIgnore } from '../../src/core/export/gitleaksignore.ts';

/** Fake transport, not a second SQL/ledger implementation. Records exactly which network operations were requested. */
class FakeClient implements StructuralSupabaseClient {
  rows: Record<string, unknown>[] = [];
  sent: RulingCloudInsert[] = [];
  columns: string[] = [];
  requests = 0;
  pageCap = 500;
  error: unknown = null;
  onRead: (() => void) | undefined;
  from(_table: 'rulings'): RulingsCloudTable {
    this.requests++;
    return {
      insert: (row) => {
        this.sent.push(structuredClone(row));
        return { select: (columns) => {
          this.columns.push(columns);
          return { single: async () => {
            if (this.error !== null) return { data: null, error: this.error };
            const saved = { ...structuredClone(row), event_id: String(this.rows.length + 1), created_at: '2026-10-24T12:00:00.000Z' };
            this.rows.push(saved);
            return { data: structuredClone(saved), error: null };
          } };
        } };
      },
      select: (columns) => { this.columns.push(columns); return new FakeSelect(this); },
    };
  }
}
class FakeSelect implements RulingsCloudSelect {
  private client: FakeClient;
  private filters = new Map<string, string>();
  private start = 0;
  private end = 499;
  constructor(client: FakeClient) { this.client = client; }
  eq(column: 'user_id' | 'project_key', value: string): this { this.filters.set(column, value); return this; }
  order(_column: 'created_at' | 'event_id', _options: { ascending: boolean }): this { return this; }
  range(from: number, to: number): this { this.start = from; this.end = to; return this; }
  then<TResult1 = RulingsCloudResult, TResult2 = never>(
    onfulfilled?: ((value: RulingsCloudResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    const filtered = this.client.rows.filter((row) => [...this.filters].every(([key, value]) => row[key] === value));
    filtered.sort((a, b) => {
      const time = Date.parse(String(a.created_at)) - Date.parse(String(b.created_at));
      const left = BigInt(String(a.event_id)); const right = BigInt(String(b.event_id));
      return time || (left < right ? -1 : left > right ? 1 : 0);
    });
    const data = structuredClone(filtered.slice(this.start, Math.min(this.end + 1, this.start + this.client.pageCap)));
    this.client.onRead?.();
    return Promise.resolve({ data, error: this.client.error }).then(onfulfilled, onrejected);
  }
}
const allowed = (): CloudRulingsAuthorization => ({ userId: scope.ownerId, cloudStorage: true });
defineRulingsStoreContract('Supabase fake client', () => new SupabaseRulingsStore(new FakeClient(), allowed), { rejectForeignOwner: true });

describe('cloud authorization and boundary', () => {
  it('maps path-bearing operational fingerprints before cloud binding, replays opaque ids, and preserves local ignore export', async () => {
    // what_bug_this_catches: printable scanner fingerprints carried a complete report path into cloud finding_id.
    const guard = guardFor();
    const fingerprint = 'C:/private/repository/src/config.ts:sample-rule:5';
    const finding = findingFor({ id: fingerprint, fingerprint, path: 'C:/private/repository/src/config.ts' });
    const base: Session = { items: [{ position: 0, finding, decision: { band: 'dismiss', stage: 1, reasons: [] }, judge: null, human: 'pending' }],
      blocked: 0, candidates: 1, format: 'gitleaks', demo: false };
    const salt = new Uint8Array(32).fill(41);
    const client = new FakeClient(); const store = new SupabaseRulingsStore(client, allowed);
    const mapped = await mapCloudFindingIds(base, scope, salt, guard);
    const prepared = await prepareJourney(mapped, [], scope, guard);
    const opaque = prepared.items[0].finding.id;
    expect(opaque).toMatch(/^[0-9a-f]{64}$/);
    await store.append(rulingDraft(prepared, prepared.items[0], 'approved_dismissal', ''), guard);
    expect(JSON.stringify(client.sent)).not.toContain(finding.path);
    expect(JSON.stringify(client.sent)).not.toContain(fingerprint);
    expect(client.sent[0].finding_id).toBe(opaque);
    const remapped = await mapCloudFindingIds(base, scope, salt, guard);
    expect(remapped.items[0].finding.id).toBe(opaque);
    const restored = await prepareJourney(remapped, await store.list(scope), scope, guard);
    expect(restored.items[0].human).toBe('approved_dismissal');
    const item = restored.items[0];
    const ignore = exportGitleaksIgnore([{ finding: item.finding, band: item.decision.band, ruling: item.ruling }],
      new Map([[opaque, item.binding!]]), scope, guard);
    expect(ignore.text).toBe(fingerprint + '\n');
    for (const changed of [findingFor({ ...finding, valueTag: 'c'.repeat(64) }),
      findingFor({ ...finding, maskedValue: '*********' as typeof finding.maskedValue })]) {
      const next = await mapCloudFindingIds({ ...base, items: [{ ...base.items[0], finding: changed }] }, scope, salt, guard);
      const replay = await prepareJourney(next, await store.list(scope), scope, guard);
      expect(replay.items[0].human).toBe('pending');
      expect(replay.items[0].replayReason).toBeDefined();
    }
    expect(await mapCloudFindingIds(base, LOCAL_SCOPE, salt, guard)).toBe(base);
    const otherScope = await mapCloudFindingIds(base, { ...scope, projectKey: 'other-project' }, salt, guard);
    expect(otherScope.items[0].finding.id).not.toBe(opaque);
    const rejectingGuard = { ...guard, check(text: string, boundary: Parameters<typeof guard.check>[1]) {
      if (text === opaque) throw new LeakGuardError(boundary); guard.check(text, boundary);
    } };
    const withheld = await mapCloudFindingIds(base, scope, salt, rejectingGuard);
    expect(withheld.items).toEqual([]);
    expect(withheld.blocked).toBe(1);
    const before = client.requests;
    for (const item of withheld.items) await store.append(rulingDraft(prepared, item, 'approved_dismissal', ''), rejectingGuard);
    expect(client.requests).toBe(before);
  });
  it('makes zero requests without explicit storage consent, with sign-in alone, or for another owner', async () => {
    // what_bug_this_catches: reading/writing cloud history just because a client or signed-in user exists.
    const client = new FakeClient();
    for (const authorize of [undefined, () => ({ userId: scope.ownerId, cloudStorage: false }), () => ({ userId: null, cloudStorage: true })]) {
      const store = new SupabaseRulingsStore(client, authorize);
      await expect(store.append(draftFor(), guardFor())).rejects.toMatchObject({ code: 'unavailable' });
      await expect(store.list(scope)).rejects.toMatchObject({ code: 'unavailable' });
    }
    const store = new SupabaseRulingsStore(client, allowed);
    await expect(store.append(draftFor({ ownerId: 'other-owner' }), guardFor())).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(store.list({ ...scope, ownerId: 'other-owner' })).rejects.toMatchObject({ code: 'invalid_input' });
    store.close();
    await expect(store.list(scope)).rejects.toMatchObject({ code: 'unavailable' });
    expect(client.requests).toBe(0);
  });
  it('guards before any request and sends only the exact sanitized closed row', async () => {
    // what_bug_this_catches: passing raw note/additional finding fields or an unchecked snake_case payload to Supabase.
    const client = new FakeClient(); const store = new SupabaseRulingsStore(client, allowed);
    await expect(store.append(draftFor({ note: 'danger' }), guardFor(['danger']))).rejects.toBeInstanceOf(LeakGuardError);
    await expect(store.append(draftFor(), NOT_READY_GUARD)).rejects.toBeInstanceOf(LeakGuardError);
    // Clean camelCase input is safe, but this known value collides with a wire key and must still block the call.
    await expect(store.append(draftFor(), guardFor(['content_hash']))).rejects.toBeInstanceOf(LeakGuardError);
    expect(client.requests).toBe(0);
    await store.append(draftFor({ note: '  reviewed\u0000 safely  ' }), guardFor());
    expect(client.sent[0].note).toBe('reviewed safely');
    expect(Object.keys(client.sent[0]).sort()).toEqual(['audit_cohort_id', 'content_hash', 'decision', 'finding_id', 'is_audit', 'note', 'project_key', 'reason_code', 'user_id', 'value_tag']);
    expect(client.columns[0]).toBe(RULINGS_COLUMNS);
    expect(RULINGS_COLUMNS).toContain('event_id::text');
  });
  it('paginates beyond a server cap and retains bigint event identities without JS rounding', async () => {
    // what_bug_this_catches: truncated histories or rounded identities applying an obsolete approval after a rescan.
    const client = new FakeClient(); client.pageCap = 1;
    const store = new SupabaseRulingsStore(client, allowed);
    await store.append(draftFor(), guardFor());
    await store.append(draftFor({ decision: 'real' }), guardFor());
    client.rows[0].event_id = '9007199254740992'; client.rows[1].event_id = '9007199254740993';
    const before = client.requests;
    expect((await store.list(scope)).map((event) => event.eventId)).toEqual(['9007199254740992', '9007199254740993']);
    expect(client.requests - before).toBe(3); // two capped pages plus an empty terminator
  });
  it('checks current consent on each operation/page and omits unsafe server diagnostics', async () => {
    // what_bug_this_catches: an earlier opt-in authorizing later requests after revoke, or leaking service error text.
    const client = new FakeClient(); let auth = allowed();
    const store = new SupabaseRulingsStore(client, () => auth);
    await store.append(draftFor(), guardFor());
    const before = client.requests;
    client.onRead = () => { auth = { ...auth, cloudStorage: false }; };
    await expect(store.list(scope)).rejects.toMatchObject({ code: 'unavailable' });
    expect(client.requests).toBe(before + 1);
    client.onRead = undefined; auth = allowed(); client.error = { message: 'untrusted report diagnostic' };
    const error = await store.list(scope).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'storage', message: '' });
    expect(String(error)).toBe('');
  });
});
