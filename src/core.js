import { MemoryStorage } from './adapters.js';

/*
 * PermissionCache 核心：缓存 + 精确 TTL + 失效广播 + 降级 + 异常提示
 * 不直接依赖任何浏览器 API，全部通过 adapters 注入，便于测试与降级替换。
 */

const DEFAULTS = {
  ttl: 60_000,
  staleExtra: null, // null => 与 ttl 相同
  broadcastKey: 'permission-cache',
};

class Emitter {
  constructor() { this._h = new Map(); }
  on(type, fn) {
    if (!this._h.has(type)) this._h.set(type, new Set());
    this._h.get(type).add(fn);
    return () => this._h.get(type)?.delete(fn);
  }
  emit(type, payload) {
    this._h.get(type)?.forEach((fn) => { try { fn(payload); } catch { /* 监听器异常不影响主流程 */ } });
  }
}

export class PermissionCacheError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'PermissionCacheError';
    if (cause) this.cause = cause;
  }
}

export class PermissionCache extends Emitter {
  /**
   * adapters: { storage, scheduler, broadcaster }
   * options:  { ttl, staleExtra, fetchPermission, knownKeys, broadcastKey }
   */
  constructor(adapters, options = {}) {
    super();
    this.opts = { ...DEFAULTS, ...options };
    this.fetchPermission = options.fetchPermission;
    this.storage = adapters.storage;
    this.memory = null; // 存储降级时使用
    this.scheduler = adapters.scheduler;
    this.broadcaster = adapters.broadcaster || null;
    this.broadcastKey = this.opts.broadcastKey;
    this.knownKeys = new Set(options.knownKeys || []);

    this._mem = new Map();        // 热副本，保证同步判定
    this._timers = new Map();     // key -> timeoutId
    this._inflight = new Map();   // key -> Promise（去重并发回源）
    this._expirePhase = new Map(); // key -> 后台重校验来源（用于 error 事件标注阶段）
    this._closed = false;

    // 降级事件（adapter 自身不可用时抛出）
    this.storage.on?.('degrade', (p) => this.#onStorageDegrade(p));
    this.scheduler.on?.('degrade', (p) => this.emit('degrade', { layer: 'scheduler', ...p }));
    this.broadcaster?.on?.('degrade', (p) => this.emit('degrade', { layer: 'broadcaster', ...p }));

    // 跨标签页失效广播
    this.broadcaster?.on?.(this.broadcastKey, (msg) => this.#onRemoteMessage(msg));
  }

  /* ---------- 存储降级 ---------- */
  #onStorageDegrade(info) {
    if (this.memory) return;
    this.memory = new MemoryStorage();
    this.storage = this.memory;
    this.emit('degrade', { layer: 'storage', ...info });
  }

  #safeStorage(fnName, ...args) {
    // adapter 方法可能同步抛错也可能返回 rejected Promise，统一成 Promise 链
    return Promise.resolve()
      .then(() => this.storage[fnName](...args))
      .catch((err) => {
        this.#onStorageDegrade({ reason: 'runtime-error', error: String(err?.message || err), action: fnName });
        return this.memory[fnName](...args);
      });
  }

  /* ---------- 内部工具 ---------- */
  #ttl(key) {
    const t = typeof this.opts.ttl === 'function' ? this.opts.ttl(key) : this.opts.ttl;
    return Math.max(0, Number(t) || 0);
  }

  #staleExtra(key) {
    const s = this.opts.staleExtra;
    if (s == null) return this.#ttl(key);
    return Math.max(0, typeof s === 'function' ? s(key) : s);
  }

  async #loadEntry(key) {
    const entry = await this.#safeStorage('get', key);
    if (entry) this._mem.set(key, entry); else this._mem.delete(key);
    return entry;
  }

  #entryState(entry, now) {
    if (!entry) return 'missing';
    if (now < entry.expiresAt) return 'fresh';
    if (now < entry.expiresAt + entry.staleExtra) return 'stale';
    return 'expired';
  }

  #armTimer(key) {
    if (this.scheduler.setTimeout === undefined) return;
    const old = this._timers.get(key);
    if (old !== undefined) this.scheduler.clearTimeout(old);
    const entry = this._mem.get(key);
    if (!entry) return;
    const delay = entry.expiresAt - this.scheduler.now();
    if (delay > 0) {
      this._timers.set(key, this.scheduler.setTimeout(() => {
        this._timers.delete(key);
        // revalidate 后台模式会自行发 'revalidate:error'/'error' 事件
        this.#handleExpired(key).catch(() => {});
      }, delay));
    }
  }

  async #persist(key, value, now) {
    const ttl = this.#ttl(key);
    const entry = {
      key,
      value,
      createdAt: now,
      expiresAt: now + ttl,
      staleExtra: this.#staleExtra(key),
    };
    this._mem.set(key, entry);
    await this.#safeStorage('set', key, entry);
    this.#armTimer(key);
    this.emit('set', { key, entry });
    return entry;
  }

  async #handleExpired(key) {
    // 过期即触发后台重新校验（TTL 精确：用绝对时间戳判定，不依赖 setTimeout 抖动）
    this._expirePhase.set(key, 'expire-revalidate');
    this.emit('expired', { key });
    try {
      return await this.revalidate(key, { background: true });
    } finally {
      this._expirePhase.delete(key);
    }
  }

  /* ---------- 公开 API ---------- */

  /** 启动：把持久层数据装入热副本并为未过期数据补定时器 */
  async warm() {
    const keys = await this.#safeStorage('keys');
    const now = this.scheduler.now();
    for (const key of keys) {
      const entry = await this.#safeStorage('get', key);
      if (!entry) continue;
      this.knownKeys.add(key);
      if (this.#entryState(entry, now) === 'fresh') {
        this._mem.set(key, entry);
        this.#armTimer(key);
      }
    }
    return this.snapshot();
  }

  snapshot(now = this.scheduler.now()) {
    const out = {};
    for (const key of new Set([...this.knownKeys, ...this._mem.keys()])) {
      const entry = this._mem.get(key);
      out[key] = entry
        ? { key, state: this.#entryState(entry, now), entry, remaining: Math.max(0, entry.expiresAt - now) }
        : { key, state: 'missing', entry: null, remaining: 0 };
    }
    return out;
  }

  peek(key) {
    const entry = this._mem.get(key);
    if (!entry) return { key, state: 'missing', entry: null, remaining: 0 };
    const now = this.scheduler.now();
    return { key, state: this.#entryState(entry, now), entry, remaining: Math.max(0, entry.expiresAt - now) };
  }

  /**
   * 读取权限：
   * fresh  -> 直接返回缓存
   * stale  -> 先返回旧值，后台异步重新校验（SWR）
   * expired/missing -> 回源；失败时旧值兜底，再失败抛错
   */
  async get(key, opts = {}) {
    if (this._closed) throw new PermissionCacheError('PermissionCache 已关闭');
    let entry = this._mem.get(key);
    if (!entry || this.#entryState(entry, this.scheduler.now()) === 'expired') {
      // 过期条目可能已被后台失败流程淘汰，以持久层为准；没有再退回内存中的旧值兜底
      const stored = await this.#loadEntry(key);
      if (stored) entry = stored;
      else entry = undefined;
    }
    const now = this.scheduler.now();
    const state = this.#entryState(entry, now);

    if (state === 'fresh' && !opts.forceRefresh) {
      this.emit('hit', { key, entry });
      return { value: entry.value, state: 'fresh', fromCache: true };
    }

    if (state === 'stale' && !opts.forceRefresh) {
      this.emit('hit', { key, state: 'stale', entry });
      this.revalidate(key, { background: true }).catch(() => {});
      return { value: entry.value, state: 'stale', fromCache: true };
    }

    try {
      const value = await this.revalidate(key);
      return { value, state: 'remote', fromCache: false };
    } catch (err) {
      // 回源失败：在 stale-while-revalidate 宽限期外也用最后已知值降级
      if (entry) {
        this.emit('fallback', { key, entry, error: err });
        return { value: entry.value, state: 'fallback', fromCache: true, error: err };
      }
      this.emit('error', { key, phase: 'fetch', background: false, error: err });
      throw err instanceof PermissionCacheError ? err
        : new PermissionCacheError(`权限 [${key}] 回源失败且无缓存可用: ${err?.message || err}`, err);
    }
  }

  /** 回源并写入缓存；相同 key 的并发调用自动去重 */
  revalidate(key, opts = {}) {
    if (this._inflight.has(key)) return this._inflight.get(key);
    const p = (async () => {
      if (typeof this.fetchPermission !== 'function')
        throw new PermissionCacheError('未配置 fetchPermission 回源函数');
      this.emit('revalidate:start', { key, background: !!opts.background });
      try {
        const value = await this.fetchPermission(key);
        await this.#persist(key, value, this.scheduler.now());
        this.emit('revalidate:done', { key, value, background: !!opts.background });
        return value;
      } catch (err) {
        this.emit('revalidate:error', { key, background: !!opts.background, error: err });
        if (opts.background) {
          // 热副本中的过期条目淘汰：下次 get 从持久层加载旧值并走 fallback/重试路径
          const memEntry = this._mem.get(key);
          if (memEntry && this.scheduler.now() >= memEntry.expiresAt + memEntry.staleExtra) {
            this._mem.delete(key);
          }
          // 后台失败不中断业务：统一发 error 事件供 UI 提示；Promise 吞掉以防 unhandledRejection
          this.emit('error', {
            key,
            phase: this._expirePhase?.get(key) || 'background-revalidate',
            background: true,
            error: err,
          });
          this._expirePhase?.delete(key);
        } else {
          throw err;
        }
      } finally {
        this._inflight.delete(key);
      }
    })();
    this._inflight.set(key, p);
    return p;
  }

  /** 失效单个 key：本地立即删除并立即重新校验，同时广播其他标签页 */
  async invalidate(key, opts = {}) {
    this.knownKeys.add(key);
    await this.#deleteLocal(key);
    this.emit('invalidate', { key, origin: 'local' });
    if (opts.broadcast !== false) this.#post({ type: 'invalidate', key });
    let revalidate = null;
    if (opts.revalidate !== false) {
      revalidate = this.revalidate(key, { background: !!opts.background });
      revalidate.catch(() => {}); // 已通过 error 事件提示，避免悬空 rejection
    }
    return { revalidate };
  }

  /** 全部失效 */
  async invalidateAll(opts = {}) {
    const keys = new Set([...this.knownKeys, ...this._mem.keys(), ...await this.#safeStorage('keys')]);
    for (const key of keys) await this.#deleteLocal(key);
    this.knownKeys = new Set(keys);
    this.emit('invalidate:all', { origin: 'local', keys: [...keys] });
    if (opts.broadcast !== false) this.#post({ type: 'invalidate-all', keys: [...keys] });
    let revalidateAll = null;
    if (opts.revalidate !== false) {
      revalidateAll = Promise.all([...keys].map((k) =>
        this.revalidate(k, { background: true }).then(
          () => {},
          (err) => this.emit('error', { key: k, phase: 'invalidate-all-revalidate', background: true, error: err })
        )));
    }
    return { revalidateAll };
  }

  async #deleteLocal(key) {
    const t = this._timers.get(key);
    if (t !== undefined) { this.scheduler.clearTimeout(t); this._timers.delete(key); }
    this._inflight.delete(key);
    this._mem.delete(key);
    await this.#safeStorage('delete', key);
  }

  #post(msg) {
    if (!this.broadcaster) return;
    try {
      this.broadcaster.post(this.broadcastKey, { ...msg, at: this.scheduler.now(), origin: this.broadcastKey + '#' + (this._tabId ??= Math.random().toString(36).slice(2, 8)) });
    } catch (err) {
      // 广播失败不阻断本地失效流程
      this.emit('degrade', { layer: 'broadcaster', reason: 'post-error', error: String(err?.message || err) });
    }
  }

  async #onRemoteMessage(msg) {
    if (!msg || msg.origin === this._tabId) return;
    try {
      if (msg.type === 'invalidate' && msg.key) {
        await this.#deleteLocal(msg.key);
        this.knownKeys.add(msg.key);
        this.emit('invalidate', { key: msg.key, origin: 'remote' });
        // 广播及时：收到失效立即重新校验
        this.revalidate(msg.key, { background: true }).catch(() => {});
      } else if (msg.type === 'invalidate-all') {
        const keys = new Set([...(msg.keys || []), ...this.knownKeys, ...this._mem.keys(), ...await this.#safeStorage('keys')]);
        for (const key of keys) await this.#deleteLocal(key);
        this.knownKeys = new Set(keys);
        this.emit('invalidate:all', { origin: 'remote', keys: [...keys] });
        for (const key of keys) {
          this.revalidate(key, { background: true }).catch(() => {});
        }
      }
    } catch (err) {
      this.emit('error', { phase: 'remote-message', background: true, error: err });
    }
  }

  async close() {
    this._closed = true;
    for (const t of this._timers.values()) this.scheduler.clearTimeout(t);
    this._timers.clear();
    await this.storage.close?.();
    this.scheduler.close?.();
    this.broadcaster?.close?.();
    this.emit('close', {});
  }
}

export default PermissionCache;
