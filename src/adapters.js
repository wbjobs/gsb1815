/*
 * 适配层：每个适配器都实现“能力探测 -> 失败即降级”，并通过 'degrade' 事件上报。
 */
import { EmitterLite } from './emitter.js';

const TIMER_CHUNK = 2_147_000_000; // setTimeout 最大安全延时

/* ---------------- 内存存储（IndexedDB 降级目标） ---------------- */
export class MemoryStorage extends EmitterLite {
  constructor() { super(); this.map = new Map(); }
  async get(key) { const v = this.map.get(key); return v ? structuredCloneSafe(v) : undefined; }
  async set(key, value) { this.map.set(key, structuredCloneSafe(value)); }
  async delete(key) { this.map.delete(key); }
  async keys() { return [...this.map.keys()]; }
  async close() {}
}

function structuredCloneSafe(v) {
  return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
}

/* ---------------- IndexedDB 存储 ---------------- */
const DB_NAME = 'permission-cache-db';
const STORE = 'entries';

export class IdbStorage extends EmitterLite {
  constructor(options = {}) {
    super();
    this.dbName = options.dbName || DB_NAME;
    this._dbPromise = null;
    this._failed = false;
  }

  static isSupported(g = globalThis) {
    return typeof g.indexedDB !== 'undefined';
  }

  _open() {
    if (this._failed) return Promise.reject(new Error('IndexedDB 已降级'));
    if (!this._dbPromise) {
      this._dbPromise = new Promise((resolve, reject) => {
        let req;
        try {
          req = globalThis.indexedDB.open(this.dbName, 1);
        } catch (err) { this._fail('open-throw', err, reject); return; }
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => this._fail('open-error', req.error, reject);
        req.onblocked = () => this._fail('blocked', new Error('IndexedDB 升级被阻塞'), reject);
      });
    }
    return this._dbPromise;
  }

  _fail(reason, error, reject) {
    if (!this._failed) {
      this._failed = true;
      this.emit('degrade', { reason, error: String(error?.message || error) });
    }
    reject?.(error instanceof Error ? error : new Error(String(error)));
  }

  _tx(mode, fn) {
    return this._open().then(
      (db) => new Promise((resolve, reject) => {
        let tx;
        try { tx = db.transaction(STORE, mode); }
        catch (err) { this._fail('tx-throw', err, reject); return; }
        const store = tx.objectStore(STORE);
        let result;
        const req = fn(store);
        if (req) req.onsuccess = () => { result = req.result; };
        if (req) req.onerror = () => this._fail('request-error', req.error, reject);
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => this._fail('abort', tx.error, reject);
        tx.onerror = () => this._fail('tx-error', tx.error, reject);
      }),
      (err) => Promise.reject(err)
    );
  }

  get(key) { return this._tx('readonly', (s) => s.get(key)); }
  set(key, value) { return this._tx('readwrite', (s) => s.put(value, key)).then(() => {}); }
  delete(key) { return this._tx('readwrite', (s) => s.delete(key)).then(() => {}); }
  keys() { return this._tx('readonly', (s) => s.getAllKeys()).then((r) => [...r]); }
  async close() {
    if (this._dbPromise) (await this._dbPromise).close?.();
  }
}

/* ---------------- 定时器：链式 setTimeout（Worker 降级目标） ---------------- */
export class TimerScheduler extends EmitterLite {
  constructor(nowImpl) {
    super();
    this._now = nowImpl || (() => Date.now());
    this.degraded = false;
  }
  now() { return this._now(); }
  setTimeout(fn, delay) {
    const id = chain(fn, Math.max(0, delay), this._now);
    return id;
  }
  clearTimeout(id) { id?.cancel?.(); }
  close() {}
}

function chain(fn, delay, now, token = { cancelled: false }) {
  const start = now();
  const step = () => {
    if (token.cancelled) return;
    const left = delay - (now() - start);
    if (left <= 0) { fn(); return; }
    const part = Math.min(left, TIMER_CHUNK);
    const h = globalThis.setTimeout(step, part);
    token.cancel = () => globalThis.clearTimeout(h);
  };
  const h = globalThis.setTimeout(step, Math.min(delay, TIMER_CHUNK));
  token.cancel = () => globalThis.clearTimeout(h);
  return { cancel: () => { token.cancelled = true; token.cancel?.(); } };
}

/* ---------------- Web Worker 定时器 ---------------- */
export class WorkerScheduler extends EmitterLite {
  constructor(workerUrl, options = {}) {
    super();
    this._now = options.now || (() => Date.now());
    this._seq = 0;
    this._pending = new Map();
    let worker;
    try {
      worker = new Worker(workerUrl);
    } catch (err) {
      throw Object.assign(new Error('Worker 创建失败'), { cause: err });
    }
    this.worker = worker;
    this._down = false;
    this.worker.onmessage = (ev) => {
      const { id } = ev.data || {};
      const item = this._pending.get(id);
      if (item) { this._pending.delete(id); item.fn(); }
    };
    this.worker.onerror = (ev) => this.#fallback('worker-error', String(ev.message || 'worker error'));
  }

  /** 运行期 Worker 故障：把未触发的定时迁移到主线程链式定时器，保证 TTL 仍然生效 */
  #fallback(reason, error) {
    if (this._down) return;
    this._down = true;
    this.emit('degrade', { reason, error });
    const now = this._now();
    for (const [id, item] of this._pending) {
      const delay = Math.max(0, item.runAt - now);
      item.handle = chain(item.fn, delay, this._now);
    }
    try { this.worker.terminate(); } catch {}
  }

  static isSupported(g = globalThis) {
    return typeof g.Worker === 'function' && typeof g.Blob === 'function';
  }

  now() { return this._now(); }

  setTimeout(fn, delay) {
    const id = `t${++this._seq}`;
    const item = { fn, runAt: this._now() + Math.max(0, delay), handle: null };
    this._pending.set(id, item);
    if (this._down) {
      item.handle = chain(fn, Math.max(0, delay), this._now);
    } else {
      try {
        // 长延时由 worker 内部分片，避免标签页节流与 32bit 上限
        this.worker.postMessage({ type: 'set', id, delay: Math.max(0, delay) });
      } catch (err) {
        this.#fallback('post-error', String(err?.message || err));
      }
    }
    return { cancel: () => {
      this._pending.delete(id);
      item.handle?.cancel?.();
      if (!this._down) {
        try { this.worker.postMessage({ type: 'clear', id }); } catch { /* 已退出则忽略 */ }
      }
    } };
  }

  clearTimeout(id) { id?.cancel?.(); }

  close() {
    try { this.worker.terminate(); } catch {}
    this._pending.clear();
  }
}

/* ---------------- BroadcastChannel（可降级为 null，不影响缓存主流程） ---------------- */
export class ChannelBroadcaster extends EmitterLite {
  constructor(channelName) {
    super();
    let ch;
    try {
      ch = new BroadcastChannel(channelName);
    } catch (err) {
      throw Object.assign(new Error('BroadcastChannel 创建失败'), { cause: err });
    }
    this.channel = ch;
    this.channel.onmessage = (ev) => {
      const data = ev.data;
      if (data && typeof data === 'object' && data.topic) this.emit(data.topic, data.msg);
    };
    this.channel.onmessageerror = (ev) =>
      this.emit('degrade', { reason: 'message-error', error: String(ev?.message || '消息反序列化失败') });
  }

  static isSupported(g = globalThis) {
    return typeof g.BroadcastChannel === 'function';
  }

  post(topic, msg) {
    // 结构化克隆失败（如不可拷贝对象）会抛错，由调用方捕获并走降级提示
    this.channel.postMessage({ topic, msg });
  }

  close() { try { this.channel.close(); } catch {} }
}
