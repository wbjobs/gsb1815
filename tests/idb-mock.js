/* 最小内存 IndexedDB mock：仅覆盖 IdbStorage 用到的 API 面 */
class MockReq {
  constructor() { this.result = undefined; this.error = null; }
}
class MockTransaction {
  constructor(db, storeName, mode) {
    this.db = db; this.storeName = storeName; this.error = null;
    const settle = (fn) => queueMicrotask(() => {
      try {
        const req = new MockReq();
        fn(req);
        this.oncomplete?.();
      } catch (e) { this.error = e; this.onabort?.(new Event('abort')); }
    });
    this._settle = settle;
  }
  objectStore() {
    const tx = this;
    return {
      get: (key) => { const r = new MockReq(); tx._settle(() => { r.result = tx.db.data.get(key); r.onsuccess?.(); }); return r; },
      put: (value, key) => { const r = new MockReq(); tx._settle(() => { tx.db.data.set(key, value); r.onsuccess?.(); }); return r; },
      delete: (key) => { const r = new MockReq(); tx._settle(() => { tx.db.data.delete(key); r.onsuccess?.(); }); return r; },
      getAllKeys: () => { const r = new MockReq(); tx._settle(() => { r.result = [...tx.db.data.keys()]; r.onsuccess?.(); }); return r; },
    };
  }
}
const DATABASES = new Map();
class MockDB {
  constructor(name) {
    if (!DATABASES.has(name)) DATABASES.set(name, new Map());
    this.data = DATABASES.get(name);
    this.objectStoreNames = { contains: () => true };
  }
  transaction(name, mode) { return new MockTransaction(this, name, mode); }
  close() {}
}
export function installIndexedDB({ failOpen = false } = {}) {
  globalThis.indexedDB = {
    open(name) {
      const req = new MockReq();
      queueMicrotask(() => {
        if (failOpen) { req.error = new Error('mock open fail'); req.onerror?.(new Event('error')); }
        else { req.result = new MockDB(name); req.onsuccess?.(new Event('success')); }
      });
      return req;
    },
  };
}
export function uninstallIndexedDB() { delete globalThis.indexedDB; }
