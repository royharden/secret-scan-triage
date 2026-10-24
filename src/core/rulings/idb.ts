import type { LeakGuard } from '../safe.ts';
import { serializeSafe } from '../safe.ts';
import { RulingsStoreError, rulingsStorageError as storageError, sanitizeRulingDraft, validScope } from './types.ts';
import type { OwnerProject, RulingDraft, RulingEvent, RulingsStore } from './types.ts';

type StoredEvent = Omit<RulingEvent, 'eventId'>;
/** Events only. Identity salt belongs exclusively to src/lib/projectSalt.ts. No update/delete API. */
export class IndexedDbRulingsStore implements RulingsStore {
  private opening: Promise<IDBDatabase> | undefined;
  private databaseName: string;
  private factory: IDBFactory | undefined;

  constructor(databaseName = 'secret-scan-triage-rulings', factory: IDBFactory | undefined = globalThis.indexedDB) {
    this.databaseName = databaseName;
    this.factory = factory;
  }
  private open(): Promise<IDBDatabase> {
    if (this.opening !== undefined) return this.opening;
    const factory = this.factory;
    if (factory === undefined) return Promise.reject(new RulingsStoreError('unavailable'));
    this.opening = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      let blocked = false;
      try { request = factory.open(this.databaseName, 1); }
      catch (error) { reject(storageError(error)); return; }
      request.onupgradeneeded = () => {
        const events = request.result.createObjectStore('events', { keyPath: 'localSeq', autoIncrement: true });
        events.createIndex('scope', ['ownerId', 'projectKey']);
      };
      request.onerror = () => reject(storageError(request.error));
      request.onblocked = () => { blocked = true; reject(new RulingsStoreError('unavailable')); };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) { db.close(); return; }
        db.onversionchange = () => { db.close(); this.opening = undefined; };
        resolve(db);
      };
    }).catch((error: unknown) => { this.opening = undefined; throw error; });
    return this.opening;
  }
  async append(draft: RulingDraft, guard: LeakGuard): Promise<RulingEvent> {
    // All checks occur before opening storage, including reload refusal and input note guarding.
    const clean = sanitizeRulingDraft(draft, guard);
    const createdAt = new Date().toISOString();
    const stored: StoredEvent = { ...clean, createdAt };
    serializeSafe(stored, 'rulings_idb', guard, clean.findingId);
    const db = await this.open();
    return new Promise<RulingEvent>((resolve, reject) => {
      let tx: IDBTransaction;
      try { tx = db.transaction('events', 'readwrite'); }
      catch (error) { reject(storageError(error)); return; }
      let result: RulingEvent | undefined;
      let failure: unknown;
      tx.oncomplete = () => result === undefined ? reject(new RulingsStoreError('storage')) : resolve(result);
      tx.onabort = () => reject(failure ?? storageError(tx.error));
      tx.onerror = () => { failure ??= storageError(tx.error); };
      try {
        const request = tx.objectStore('events').add(stored);
        request.onerror = () => { failure = storageError(request.error); };
        request.onsuccess = () => {
          try {
            const localSeq = Number(request.result);
            if (!Number.isSafeInteger(localSeq) || localSeq < 1) throw new RulingsStoreError('storage');
            result = { ...stored, localSeq, eventId: String(localSeq) };
            // Include the generated sequence and event id in the final guard before transaction commit.
            serializeSafe(result, 'rulings_idb', guard, clean.findingId);
          } catch (error) { failure = error; tx.abort(); }
        };
      } catch (error) { failure = storageError(error); tx.abort(); }
    });
  }
  async list(scope: OwnerProject): Promise<RulingEvent[]> {
    if (!validScope(scope)) throw new RulingsStoreError('invalid_input');
    const db = await this.open();
    return new Promise<RulingEvent[]>((resolve, reject) => {
      let tx: IDBTransaction;
      try { tx = db.transaction('events', 'readonly'); }
      catch (error) { reject(storageError(error)); return; }
      let result: RulingEvent[] = [];
      let failure: RulingsStoreError | undefined;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? storageError(tx.error));
      tx.onerror = () => { failure ??= storageError(tx.error); };
      try {
        const request = tx.objectStore('events').index('scope').getAll([scope.ownerId, scope.projectKey]);
        request.onerror = () => { failure = storageError(request.error); };
        request.onsuccess = () => {
          result = (request.result as StoredEvent[]).map((event) => ({ ...event, eventId: String(event.localSeq) }));
        };
      } catch (error) { failure = storageError(error); tx.abort(); }
    });
  }
  close(): void {
    const opening = this.opening;
    this.opening = undefined;
    if (opening !== undefined) void opening.then((db) => db.close(), () => undefined);
  }
}
