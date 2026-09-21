import { IndexedPermissionStore, keyMatches } from './idb-store.js';
import { MemoryPermissionStore } from './memory-store.js';

const CHANNEL_NAME = 'permission-cache';
const TTL_SWEEP_MS = 1000;

export class PermissionWorkerContext {
  constructor(options = {}) {
    this.clientId = Math.random().toString(36).slice(2, 10);
    this.storeFactory = options.storeFactory ?? (() => new IndexedPermissionStore());
    this.fallbackStoreFactory = options.fallbackStoreFactory ?? (() => new MemoryPermissionStore());
    this.channelFactory = options.channelFactory ?? ((name) => new BroadcastChannel(name));
    this.channelName = options.channelName ?? CHANNEL_NAME;
    this.now = options.now ?? (() => Date.now());
    this.setIntervalFn = options.setIntervalFn ?? globalThis.setInterval;
    this.clearIntervalFn = options.clearIntervalFn ?? globalThis.clearInterval;
    this.postMessage = options.postMessage ?? ((message) => globalThis.postMessage(message));
    this.onMessage = options.onMessage ?? (handler => globalThis.addEventListener('message', event => handler(event.data)));
    this.records = new Map();
    this.revalidating = new Set();
    this.waiters = new Map();
    this.store = null;
    this.channel = null;
    this.channelError = null;
    this.started = false;
    this.sweepTimer = null;
    this.timers = new Map();
    this.setTimeoutFn = options.setTimeoutFn ?? globalThis.setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? globalThis.clearTimeout;
  }

  async start() {
    if (this.started) {
      return;
    }
    this.started = true;
    this.store = this.storeFactory();

    try {
      this.records = await this.store.getAll();
    } catch (error) {
      this.store = this.fallbackStoreFactory();
      this.records = new Map();
      this.emitError('indexeddb', error);
    }

    try {
      this.channel = this.channelFactory(this.channelName);
      this.channel.onmessage = (event) => this.handleBroadcast(event.data);
    } catch (error) {
      this.channel = null;
      this.channelError = error;
      this.emitError('broadcast', error);
    }

    this.onMessage((message) => {
      this.handleMessage(message).catch((error) => {
        this.emitError('worker', error);
      });
    });
    const startupNow = this.now();
    for (const [key, record] of this.records) {
      if (!record.stale && record.expiresAt !== 0 && record.expiresAt <= startupNow) {
        const expiredRecord = {
          ...record,
          stale: true,
          expiresAt: startupNow
        };
        this.records.set(key, expiredRecord);
        this.store.set(key, expiredRecord).catch((error) => this.emitError('indexeddb-write', error));
      } else if (!record.stale && record.expiresAt !== 0 && record.expiresAt > startupNow) {
        this.scheduleExpiry(key, record);
      }
    }
    this.sweepTimer = this.setIntervalFn(() => this.sweepExpired(), TTL_SWEEP_MS);

    this.post({
      type: 'WORKER_READY',
      clientId: this.clientId,
      cacheMode: this.channel ? 'worker' : 'worker-no-broadcast',
      records: this.exportSnapshot(),
      now: this.now()
    });
  }

  async handleMessage(message) {
    if (!message || typeof message !== 'object') {
      return;
    }

    switch (message.type) {
      case 'GET':
        await this.handleGet(message);
        break;
      case 'SET':
        await this.handleSet(message);
        break;
      case 'INVALIDATE':
        await this.handleInvalidate(message);
        break;
      case 'REVALIDATED':
        this.handleRevalidated(message);
        break;
      case 'REVALIDATE_ERROR':
        this.handleRevalidateError(message);
        break;
      default:
        break;
    }
  }

  async handleGet(message) {
    const record = this.records.get(message.key);
    const now = this.now();

    if (!record) {
      this.post({
        type: 'GET_MISS',
        requestId: message.requestId,
        key: message.key
      });
      return;
    }

    const fresh = record.expiresAt > now;
    this.post({
      type: 'GET_RESULT',
      requestId: message.requestId,
      key: message.key,
      record,
      fresh
    });

    if (!fresh) {
      await this.requestRevalidation(message.key, 'ttl', { origin: message.origin ?? 'main' });
    }
  }

  async handleSet(message) {
    const now = this.now();
    const ttl = Number.isFinite(message.ttl) && message.ttl > 0 ? message.ttl : 0;
    const record = {
      value: message.value,
      cachedAt: now,
      expiresAt: ttl > 0 ? now + ttl : 0,
      ttl,
      stale: false,
      source: 'remote'
    };

    this.records.set(message.key, record);
    this.resolveWaiters(message.key, record);
    this.scheduleExpiry(message.key, record);

    try {
      await this.store.set(message.key, record);
    } catch (error) {
      this.emitError('indexeddb-write', error);
    }

    this.post({
      type: 'SET_ACK',
      requestId: message.requestId,
      key: message.key,
      record,
      at: now
    });

    this.post({
      type: 'CACHE_UPDATED',
      key: message.key,
      record,
      reason: message.reason ?? 'refresh',
      origin: message.origin ?? 'main',
      now
    });
  }

  async handleInvalidate(message) {
    const now = this.now();
    const changed = [];

    for (const [key, record] of this.records) {
      if (keyMatches(key, message.key)) {
        const nextRecord = {
          ...record,
          stale: true,
          expiresAt: now,
          invalidatedAt: now
        };
        this.records.set(key, nextRecord);
        this.clearExpiry(key);
        changed.push([key, nextRecord]);
      }
    }

    await Promise.all(changed.map(async ([key, record]) => {
      try {
        await this.store.set(key, record);
      } catch (error) {
        this.emitError('indexeddb-write', error);
      }
    }));

    if (message.broadcast !== false) {
      this.broadcast({
        type: 'INVALIDATE',
        key: message.key,
        originClientId: this.clientId,
        reason: message.reason ?? 'manual',
        at: now
      });
    }

    this.post({
      type: 'INVALIDATED',
      requestId: message.requestId,
      key: message.key,
      records: this.exportSnapshot(),
      matchedKeys: changed.map(([key]) => key),
      now
    });

    await Promise.allSettled(changed.map(async ([key]) => {
      await this.requestRevalidation(key, 'invalidate', {
        requestId: message.requestId,
        origin: 'local'
      });
    }));

    this.post({
      type: 'INVALIDATION_COMPLETE',
      requestId: message.requestId,
      key: message.key,
      matchedKeys: changed.map(([key]) => key),
      now: this.now()
    });
  }

  handleRevalidated(message) {
    this.revalidating.delete(message.key);
  }

  handleRevalidateError(message) {
    this.revalidating.delete(message.key);
    const pending = this.waiters.get(message.key);
    if (pending) {
      const error = message.error instanceof Error ? message.error : new Error(message.error);
      pending.forEach(({ reject }) => reject(error));
      this.waiters.delete(message.key);
    }
  }

  async requestRevalidation(key, reason, detail = {}) {
    this.revalidating.add(key);
    const completion = this.waitFor(key);
    this.post({
      type: 'REVALIDATE',
      key,
      reason,
      detail,
      at: this.now()
    });
    return completion;
  }

  waitFor(key) {
    return new Promise((resolve, reject) => {
      if (!this.waiters.has(key)) {
        this.waiters.set(key, new Set());
      }
      this.waiters.get(key).add({ resolve, reject });
    });
  }

  resolveWaiters(key, record) {
    this.revalidating.delete(key);
    const pending = this.waiters.get(key);
    if (!pending) {
      return;
    }
    pending.forEach(({ resolve }) => resolve(record));
    this.waiters.delete(key);
  }

  handleBroadcast(message) {
    if (!message || message.originClientId === this.clientId) {
      return;
    }

    if (message.type === 'INVALIDATE') {
      const now = this.now();
      const matchedKeys = [];

      for (const [key, record] of this.records) {
        if (keyMatches(key, message.key)) {
          const nextRecord = {
            ...record,
            stale: true,
            expiresAt: now,
            invalidatedAt: now,
            invalidatedBy: message.originClientId
          };
          this.records.set(key, nextRecord);
          this.clearExpiry(key);
          matchedKeys.push(key);
          this.store.set(key, nextRecord).catch((error) => this.emitError('indexeddb-write', error));
        }
      }

      this.post({
        type: 'REMOTE_INVALIDATED',
        key: message.key,
        originClientId: message.originClientId,
        reason: message.reason,
        matchedKeys,
        records: this.exportSnapshot(),
        at: now
      });

      matchedKeys.forEach((key) => {
        this.requestRevalidation(key, 'broadcast', {
          originClientId: message.originClientId
        });
      });
    }
  }

  sweepExpired() {
    const now = this.now();
    for (const [key, record] of this.records) {
      if (!record.stale && record.expiresAt !== 0 && record.expiresAt <= now) {
        const nextRecord = {
          ...record,
          stale: true,
          expiresAt: now
        };
        this.records.set(key, nextRecord);
        this.clearExpiry(key);
        this.store.set(key, nextRecord).catch((error) => this.emitError('indexeddb-write', error));
        this.post({
          type: 'TTL_EXPIRED',
          key,
          record: nextRecord,
          at: now
        });
        this.requestRevalidation(key, 'ttl').catch((error) => this.emitError('worker', error));
      }
    }
  }

  broadcast(message) {
    if (!this.channel) {
      this.emitError('broadcast', new Error('BroadcastChannel is unavailable'));
      return;
    }
    try {
      this.channel.postMessage(message);
    } catch (error) {
      this.emitError('broadcast', error);
    }
  }

  scheduleExpiry(key, record) {
    this.clearExpiry(key);
    if (record.stale || record.expiresAt === 0) {
      return;
    }

    const delay = Math.max(0, record.expiresAt - this.now());
    const timer = this.setTimeoutFn(() => {
      this.timers.delete(key);
      this.sweepExpired();
    }, delay);
    this.timers.set(key, timer);
  }

  clearExpiry(key) {
    const timer = this.timers.get(key);
    if (timer !== undefined) {
      this.clearTimeoutFn(timer);
      this.timers.delete(key);
    }
  }

  exportSnapshot() {
    return new Map(this.records);
  }

  emitError(scope, error) {
    this.post({
      type: 'WORKER_ERROR',
      scope,
      error: error instanceof Error ? error.message : String(error),
      at: this.now()
    });
  }

  post(message) {
    this.postMessage(message);
  }
}

if (globalThis.self && typeof globalThis.self.postMessage === 'function' && typeof globalThis.WorkerGlobalScope !== 'undefined' && globalThis.self instanceof globalThis.WorkerGlobalScope) {
  const context = new PermissionWorkerContext();
  context.start().catch((error) => {
    globalThis.self.postMessage({
      type: 'WORKER_ERROR',
      scope: 'startup',
      error: error.message,
      at: Date.now()
    });
  });
}
