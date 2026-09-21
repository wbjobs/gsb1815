const DB_NAME = 'permission-cache';
const STORE_NAME = 'permissions';
const DEFAULT_VERSION = 1;

function clone(value) {
  if (value === undefined) {
    return value;
  }
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export class IndexedPermissionStore {
  constructor(options = {}) {
    this.dbName = options.dbName ?? DB_NAME;
    this.storeName = options.storeName ?? STORE_NAME;
    this.version = options.version ?? DEFAULT_VERSION;
    this.idb = options.indexedDB ?? globalThis.indexedDB;
    this.dbPromise = null;
  }

  open() {
    if (!this.idb) {
      return Promise.reject(new Error('IndexedDB is unavailable'));
    }

    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = this.idb.open(this.dbName, this.version);

        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(this.storeName)) {
            database.createObjectStore(this.storeName);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Unable to open IndexedDB'));
        request.onblocked = () => reject(new Error('IndexedDB upgrade was blocked'));
      });
    }

    return this.dbPromise;
  }

  async transaction(mode, callback) {
    const database = await this.open();
    const transaction = database.transaction(this.storeName, mode);
    const store = transaction.objectStore(this.storeName);

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve(undefined);
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction was aborted'));

      Promise.resolve(callback(store)).then((result) => {
        transaction.oncomplete = () => resolve(result);
      }, reject);
    });
  }

  async getAll() {
    return this.transaction('readonly', async (store) => {
      const keys = await requestToPromise(store.getAllKeys());
      const records = new Map();

      for (const key of keys) {
        records.set(key, clone(await requestToPromise(store.get(key))));
      }

      return records;
    });
  }

  async get(key) {
    return this.transaction('readonly', async (store) => {
      return clone(await requestToPromise(store.get(key)));
    });
  }

  async set(key, value) {
    await this.transaction('readwrite', (store) => {
      store.put(clone(value), key);
    });
  }

  async delete(key) {
    await this.transaction('readwrite', (store) => {
      store.delete(key);
    });
  }

  async close() {
    if (!this.dbPromise) {
      return;
    }
    const database = await this.dbPromise;
    database.close();
    this.dbPromise = null;
  }
}

export function keyMatches(key, target) {
  if (target === '*') {
    return true;
  }
  if (target.endsWith('*')) {
    return key.startsWith(target.slice(0, -1));
  }
  return key === target;
}
