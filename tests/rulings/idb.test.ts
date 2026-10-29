import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory as FakeIDBFactory, IDBObjectStore as FakeIDBObjectStore } from 'fake-indexeddb';
import { IndexedDbRulingsStore } from '../../src/core/rulings/idb.ts';
import { RulingsStoreError } from '../../src/core/rulings/types.ts';
import { draftFor, guardFor, scope } from './fixtures.ts';
import { defineRulingsStoreContract } from './storeContract.ts';

defineRulingsStoreContract('IndexedDB', () => new IndexedDbRulingsStore('rulings-contract', new FakeIDBFactory()));
afterEach(() => vi.restoreAllMocks());

describe('IndexedDB durability and safe failures', () => {
  it('persists across store instances with an increasing local sequence', async () => {
    // what_bug_this_catches: memory-only success or a local sequence reset after reopening a database.
    const factory = new FakeIDBFactory();
    const first = new IndexedDbRulingsStore('reload', factory);
    const a = await first.append(draftFor(), guardFor());
    first.close();
    const reopened = new IndexedDbRulingsStore('reload', factory);
    try {
      const b = await reopened.append(draftFor({ decision: 'real' }), guardFor());
      expect(b.localSeq).toBeGreaterThan(a.localSeq ?? 0);
      expect(await reopened.list(scope)).toEqual([a, b]);
    } finally { reopened.close(); }
  });
  it('surfaces quota failure without browser error text or a persisted row', async () => {
    // what_bug_this_catches: claiming a ruling was saved when browser quota rejected the write.
    const store = new IndexedDbRulingsStore('quota', new FakeIDBFactory());
    vi.spyOn(FakeIDBObjectStore.prototype, 'add').mockImplementationOnce(() => {
      throw new DOMException('untrusted browser diagnostic', 'QuotaExceededError');
    });
    try {
      const error = await store.append(draftFor(), guardFor()).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(RulingsStoreError);
      expect(error).toMatchObject({ code: 'quota', message: '' });
      expect(String(error)).toBe('');
      expect(await store.list(scope)).toEqual([]);
    } finally { store.close(); }
  });
  it('rejects a transaction abort even after its add request succeeded', async () => {
    // what_bug_this_catches: resolving append on request.onsuccess before transaction durability is known.
    const store = new IndexedDbRulingsStore('abort', new FakeIDBFactory());
    const add = FakeIDBObjectStore.prototype.add;
    vi.spyOn(FakeIDBObjectStore.prototype, 'add').mockImplementationOnce(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      const request = add.call(this, value, key);
      request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    try {
      await expect(store.append(draftFor(), guardFor())).rejects.toMatchObject({ code: 'storage' });
      expect(await store.list(scope)).toEqual([]);
    } finally { store.close(); }
  });
  it('aborts a write if its generated sequence trips the final guard', async () => {
    // what_bug_this_catches: generated IDs reaching storage without the same boundary check as caller data.
    const store = new IndexedDbRulingsStore('generated', new FakeIDBFactory());
    const base = guardFor();
    const guard = { ...base, check(text: string, boundary: Parameters<typeof base.check>[1], findingId?: string) {
      base.check(text, boundary, findingId);
      if (text.includes('"localSeq"')) throw new RulingsStoreError('storage');
    } };
    try {
      await expect(store.append(draftFor(), guard)).rejects.toBeInstanceOf(RulingsStoreError);
      expect(await store.list(scope)).toEqual([]);
    } finally { store.close(); }
  });
});
