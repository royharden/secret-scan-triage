import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory as FakeIDBFactory, IDBObjectStore as FakeIDBObjectStore } from 'fake-indexeddb';
import { IndexedDbAuditStore } from '../../src/core/audit/idb.ts';
import { createAuditCohort } from '../../src/core/audit/sampler.ts';
import { LeakGuardError, NOT_READY_GUARD } from '../../src/core/safe.ts';
import { bindingFor, guardFor, scope } from './fixtures.ts';

afterEach(() => vi.restoreAllMocks());
describe('append-only cohort persistence', () => {
  it('survives reload before any label exists, filters scope and rejects replacement', async () => {
    // what_bug_this_catches: saving only responded-to rows loses the original denominator and permits resampling history.
    const factory = new FakeIDBFactory();
    const cohort = createAuditCohort('run-a', [bindingFor()], 3);
    const first = new IndexedDbAuditStore('audits', factory);
    await first.append(scope, cohort, guardFor());
    first.close();
    const reopened = new IndexedDbAuditStore('audits', factory);
    try {
      const restored = await reopened.list(scope);
      expect(restored).toEqual([cohort]);
      expect(Object.isFrozen(restored[0].members[0])).toBe(true);
      expect(await reopened.list({ ...scope, ownerId: 'other' })).toEqual([]);
      expect(await reopened.list({ ...scope, projectKey: 'other' })).toEqual([]);
      await expect(reopened.append(scope, { ...cohort, seed: 4 }, guardFor())).rejects.toMatchObject({ code: 'storage' });
      expect(await reopened.list(scope)).toEqual([cohort]);
    } finally { reopened.close(); }
  });
  it('refuses reload/unsafe writes and surfaces quota without claiming a saved cohort', async () => {
    // what_bug_this_catches: sample metadata bypasses the guard or a failed quota write changes the recorded sample size.
    const store = new IndexedDbAuditStore('audits-quota', new FakeIDBFactory());
    const cohort = createAuditCohort('run-a', [bindingFor()], 3);
    try {
      await expect(store.append(scope, cohort, NOT_READY_GUARD)).rejects.toBeInstanceOf(LeakGuardError);
      await expect(store.append(scope, { ...cohort, runId: 'danger' }, guardFor(['danger']))).rejects.toBeInstanceOf(LeakGuardError);
      vi.spyOn(FakeIDBObjectStore.prototype, 'add').mockImplementationOnce(() => {
        throw new DOMException('untrusted browser diagnostic', 'QuotaExceededError');
      });
      await expect(store.append(scope, cohort, guardFor())).rejects.toMatchObject({ code: 'quota', message: '' });
      expect(await store.list(scope)).toEqual([]);
    } finally { store.close(); }
  });
});
