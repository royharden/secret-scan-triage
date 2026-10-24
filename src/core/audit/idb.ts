import { LeakGuardError, serializeSafe } from '../safe.ts';
import type { LeakGuard } from '../safe.ts';
import { RulingsStoreError, rulingsStorageError, validScope } from '../rulings/types.ts';
import type { OwnerProject } from '../rulings/types.ts';
import { auditSampleSize } from './sampler.ts';
import type { AuditCohort } from './sampler.ts';

interface StoredCohort extends OwnerProject { id: string; cohort: AuditCohort }

/** Reconstitute frozen plain data; keep only cohort metadata and binding triples, never labels or guard state. */
function copyCohort(cohort: AuditCohort): AuditCohort {
  if (cohort === null || typeof cohort !== 'object' || typeof cohort.id !== 'string' || cohort.id.length === 0 ||
    typeof cohort.runId !== 'string' || cohort.runId.length === 0 || !Number.isSafeInteger(cohort.seed) ||
    cohort.seed < 0 || cohort.seed > 0xffffffff || !Number.isSafeInteger(cohort.populationSize) || cohort.populationSize < 0 ||
    !Array.isArray(cohort.members) || cohort.members.length !== auditSampleSize(cohort.populationSize)) throw new RulingsStoreError('invalid_input');
  const ids = new Set<string>();
  const members = cohort.members.map((binding) => {
    if (binding === null || typeof binding !== 'object' || typeof binding.findingId !== 'string' || binding.findingId.length === 0 ||
      !/^[0-9a-f]{64}$/.test(binding.contentHash) || !/^[0-9a-f]{64}$/.test(binding.valueTag) || ids.has(binding.findingId)) throw new RulingsStoreError('invalid_input');
    ids.add(binding.findingId);
    return Object.freeze({ findingId: binding.findingId, contentHash: binding.contentHash, valueTag: binding.valueTag });
  });
  return Object.freeze({ id: cohort.id, runId: cohort.runId, seed: cohort.seed, populationSize: cohort.populationSize, members: Object.freeze(members) });
}

/** Cohorts survive reload independently of response events. Insert only; a duplicate scoped ID rejects. */
export class IndexedDbAuditStore {
  private opening: Promise<IDBDatabase> | undefined;
  private databaseName: string;
  private factory: IDBFactory | undefined;
  constructor(databaseName = 'secret-scan-triage-audits', factory: IDBFactory | undefined = globalThis.indexedDB) {
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
      catch (error) { reject(rulingsStorageError(error)); return; }
      request.onupgradeneeded = () => {
        const cohorts = request.result.createObjectStore('cohorts', { keyPath: ['ownerId', 'projectKey', 'id'] });
        cohorts.createIndex('scope', ['ownerId', 'projectKey']);
      };
      request.onerror = () => reject(rulingsStorageError(request.error));
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
  async append(scope: OwnerProject, cohort: AuditCohort, guard: LeakGuard): Promise<void> {
    serializeSafe({ scope, cohort }, 'rulings_idb', guard);
    if (!validScope(scope)) throw new RulingsStoreError('invalid_input');
    const clean = copyCohort(cohort);
    const stored: StoredCohort = { ownerId: scope.ownerId, projectKey: scope.projectKey, id: clean.id, cohort: clean };
    serializeSafe(stored, 'rulings_idb', guard);
    const db = await this.open();
    return new Promise<void>((resolve, reject) => {
      let tx: IDBTransaction;
      try { tx = db.transaction('cohorts', 'readwrite'); }
      catch (error) { reject(rulingsStorageError(error)); return; }
      let failure: unknown;
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(failure ?? rulingsStorageError(tx.error));
      tx.onerror = () => { failure ??= rulingsStorageError(tx.error); };
      try {
        serializeSafe(stored, 'rulings_idb', guard); // exact storage payload after async database open
        const request = tx.objectStore('cohorts').add(stored);
        request.onerror = () => { failure = rulingsStorageError(request.error); };
      } catch (error) {
        // Preserve guard type so the caller can route the boundary failure to review.
        failure = error instanceof LeakGuardError || error instanceof RulingsStoreError ? error : rulingsStorageError(error);
        tx.abort();
      }
    });
  }
  async list(scope: OwnerProject): Promise<AuditCohort[]> {
    if (!validScope(scope)) throw new RulingsStoreError('invalid_input');
    const db = await this.open();
    return new Promise<AuditCohort[]>((resolve, reject) => {
      let tx: IDBTransaction;
      try { tx = db.transaction('cohorts', 'readonly'); }
      catch (error) { reject(rulingsStorageError(error)); return; }
      let result: AuditCohort[] = [];
      let failure: RulingsStoreError | undefined;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? rulingsStorageError(tx.error));
      tx.onerror = () => { failure ??= rulingsStorageError(tx.error); };
      try {
        const request = tx.objectStore('cohorts').index('scope').getAll([scope.ownerId, scope.projectKey]);
        request.onerror = () => { failure = rulingsStorageError(request.error); };
        request.onsuccess = () => {
          try { result = (request.result as StoredCohort[]).map((row) => copyCohort(row.cohort)); }
          catch { failure = new RulingsStoreError('storage'); tx.abort(); }
        };
      } catch (error) { failure = rulingsStorageError(error); tx.abort(); }
    });
  }
  close(): void {
    const opening = this.opening;
    this.opening = undefined;
    if (opening !== undefined) void opening.then((db) => db.close(), () => undefined);
  }
}
