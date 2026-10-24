// Only the identity salt is persisted. The guard/snapshot and imported report never enter this database.
const DATABASE = 'secret-scan-triage-local';
const STORE = 'settings';
const KEY = 'projectSalt';

/** A read/write transaction serialises first-use creation across tabs. Storage failure prevents unstable identities. */
export function getProjectSalt(factory: IDBFactory = globalThis.indexedDB): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    if (!factory) { reject(new Error('')); return; }
    const open = factory.open(DATABASE, 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
    };
    open.onerror = () => reject(new Error(''));
    open.onblocked = () => reject(new Error(''));
    open.onsuccess = () => {
      const db = open.result;
      let salt: Uint8Array | undefined;
      let failed = false;
      let transaction: IDBTransaction;
      try { transaction = db.transaction(STORE, 'readwrite'); }
      catch { db.close(); reject(new Error('')); return; }
      const store = transaction.objectStore(STORE);
      const get = store.get(KEY);
      const fail = () => { failed = true; db.close(); reject(new Error('')); };
      transaction.onerror = fail;
      transaction.onabort = fail;
      transaction.oncomplete = () => {
        db.close();
        if (!failed && salt) resolve(new Uint8Array(salt));
        else reject(new Error(''));
      };
      get.onsuccess = () => {
        try {
          const stored: unknown = get.result;
          if (stored === undefined) {
            salt = globalThis.crypto.getRandomValues(new Uint8Array(32));
            store.put(salt, KEY);
          } else if (stored instanceof Uint8Array && stored.length === 32) salt = new Uint8Array(stored);
          else transaction.abort(); // Never silently replace an invalid existing identity salt.
        } catch { transaction.abort(); }
      };
    };
  });
}
