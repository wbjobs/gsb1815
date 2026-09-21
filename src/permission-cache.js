import { FallbackPermissionCache } from './fallback-cache.js';

const WORKER_URL = new URL('./permission-worker.js', import.meta.url);
const START_TIMEOUT_MS = 8000;

export class PermissionCache extends EventTarget {
  constructor(options = {}) {
    super();
    this.fetcher = options.fetcher;
    this.defaultTtl = options.defaultTtl ?? 30000;
    this.fallbackValue = options.fallbackValue ?? { allowed: false, permissions: [] };
    this.workerUrl = options.workerUrl ?? WORKER_URL;
    this.workerFactory = options.workerFactory ?? ((url) => new Worker(url, { type: 'module' }));
    this.startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
    this.worker = null;
    this.impl = null;
    this.mode = 'initializing';
    this.records = new Map();
    this.requestId = 0;
    this.pending = new Map();
    this.refreshes = new Map();
    this.started = false;
  }

  async init() {
    if (this.started) {
      return this.impl ?? this;
    }
    this.started = true;

    try {
      await this.startWorker();
    } catch (error) {
      await this.useFallback('worker-start', error);
    }

    return this;
  }

  startWorker() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        this.worker?.terminate();
        reject(new Error('Permission worker startup timed out'));
      }, this.startTimeoutMs);

      try {
        this.worker = this.workerFactory(this.workerUrl);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
        return;
      }

      if (!this.worker || typeof this.worker.postMessage !== 'function') {
        clearTimeout(timer);
        reject(new Error('Permission worker was not created'));
        return;
      }

      this.worker.onmessage = async (event) => {
        const message = event.data;
        if (message?.type === 'WORKER_READY' && !settled) {
          settled = true;
          clearTimeout(timer);
          this.mode = message.cacheMode === 'worker-no-broadcast' ? 'worker-no-broadcast' : 'worker';
          this.records = new Map(message.records);
          this.forward('ready', {
            mode: this.mode,
            records: this.getSnapshot(),
            clientId: message.clientId
          });
          resolve();
          return;
        }

        await this.handleWorkerMessage(message);
      };
      this.worker.onerror = (event) => {
        const error = event.error ?? new Error(event.message || 'Permission worker failed');
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
          return;
        }
        this.useFallback('worker-runtime', error).catch(() => {});
      };
      this.worker.onmessageerror = (event) => {
        const error = new Error('Permission worker message could not be deserialized');
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        } else {
          this.emitError('worker-message', error);
        }
      };
    });
  }

  async useFallback(scope, error) {
    if (this.impl) {
      return this.impl;
    }

    const pendingTasks = [...this.pending.values()];
    this.pending.clear();

    this.refreshes.clear();
    this.worker?.terminate();
    this.worker = null;
    this.emitError(scope, error);

    const fallback = new FallbackPermissionCache({
      fetcher: this.fetcher,
      defaultTtl: this.defaultTtl,
      fallbackValue: this.fallbackValue
    });
    fallback.addEventListener('state', (event) => {
      this.records = fallback.getSnapshot();
      this.forward(event.detail.reason, event.detail);
    });
    fallback.addEventListener('error', (event) => {
      const { error: fallbackError, ...detail } = event.detail;
      this.emitError(detail.scope, fallbackError, detail);
    });

    this.impl = fallback;
    this.mode = 'fallback';
    await fallback.init();

    pendingTasks.forEach((task) => {
      this.replayFallbackTask(fallback, task).then(task.resolve, task.reject);
    });

    return fallback;
  }

  replayFallbackTask(fallback, task) {
    if (task.type === 'GET') {
      return fallback.get(task.key);
    }
    if (task.type === 'SET') {
      return fallback.set(task.key, task.value, task.ttl);
    }
    if (task.type === 'INVALIDATE') {
      return fallback.invalidate(task.key, task.reason);
    }
    return Promise.reject(new Error(`Unknown pending worker task: ${String(task.type)}`));
  }

  async handleWorkerMessage(message) {
    if (!message) {
      return;
    }

    switch (message.type) {
      case 'GET_RESULT':
        this.resolvePending(message.requestId, {
          status: message.fresh ? 'fresh' : 'stale',
          key: message.key,
          value: message.record.value,
          record: message.record,
          source: message.fresh ? 'cache' : 'stale-cache'
        });
        if (!message.fresh) {
          this.records.set(message.key, message.record);
        }
        break;
      case 'GET_MISS':
        this.resolvePending(message.requestId, {
          status: 'miss',
          key: message.key,
          value: this.fallbackValue,
          record: null,
          source: 'fallback'
        });
        break;
      case 'CACHE_UPDATED':
        this.records.set(message.key, message.record);
        this.forward(message.reason, {
          key: message.key,
          record: message.record,
          origin: message.origin
        });
        break;
      case 'SET_ACK':
        this.resolvePending(message.requestId, {
          key: message.key,
          value: message.record.value,
          source: 'remote',
          stale: false,
          record: message.record
        });
        break;
      case 'INVALIDATED':
        this.records = new Map(message.records);
        this.forward('invalidate', {
          key: message.key,
          matchedKeys: message.matchedKeys
        });
        break;
      case 'INVALIDATION_COMPLETE':
        this.resolvePending(message.requestId, {
          key: message.key,
          matchedKeys: message.matchedKeys
        });
        break;
      case 'REMOTE_INVALIDATED':
        this.records = new Map(message.records);
        this.forward('broadcast', {
          key: message.key,
          matchedKeys: message.matchedKeys,
          originClientId: message.originClientId
        });
        break;
      case 'TTL_EXPIRED':
        this.records.set(message.key, message.record);
        this.forward('ttl', { key: message.key, record: message.record });
        break;
      case 'REVALIDATE':
        await this.revalidate(message.key, {
          reason: message.reason,
          force: message.reason === 'invalidate' || message.reason === 'broadcast'
        });
        break;
      case 'WORKER_ERROR':
        this.emitError(message.scope, new Error(message.error));
        break;
      default:
        break;
    }
  }

  async get(key) {
    await this.init();
    if (this.impl) {
      return this.impl.get(key);
    }

    const requestId = this.nextRequestId();
    const result = new Promise((resolve, reject) => {
      this.pending.set(requestId, { type: 'GET', key, resolve, reject });
    });
    this.worker.postMessage({ type: 'GET', requestId, key });
    const cached = await result;
    if (cached.status === 'miss') {
      return this.revalidate(key, { reason: 'cold-start', force: true });
    }
    return cached;
  }

  async refresh(key, options = {}) {
    await this.init();
    if (this.impl) {
      return this.impl.refresh(key, options);
    }
    return this.revalidate(key, {
      reason: options.reason ?? 'manual',
      force: options.force ?? true
    });
  }

  async invalidate(key, reason = 'manual') {
    await this.init();
    if (this.impl) {
      return this.impl.invalidate(key, reason);
    }

    const requestId = this.nextRequestId();
    const result = new Promise((resolve, reject) => {
      this.pending.set(requestId, {
        type: 'INVALIDATE',
        key,
        reason,
        resolve,
        reject
      });
    });
    this.worker.postMessage({
      type: 'INVALIDATE',
      requestId,
      key,
      reason
    });
    return result;
  }

  async set(key, value, ttl = this.defaultTtl, reason = 'set') {
    await this.init();
    if (this.impl) {
      return this.impl.set(key, value, ttl);
    }
    const requestId = this.nextRequestId();
    this.worker.postMessage({
      type: 'SET',
      requestId,
      key,
      value,
      ttl,
      reason,
      origin: 'main'
    });
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, {
        type: 'SET',
        key,
        value,
        ttl,
        resolve,
        reject
      });
    });
  }

  revalidate(key, options = {}) {
    const reason = options.reason ?? 'manual';
    const force = options.force ?? true;
    const current = this.refreshes.get(key);

    if (current && !force) {
      return current;
    }
    if (current && force) {
      return this.startRefresh(key, reason, options);
    }

    return this.startRefresh(key, reason, options);
  }

  startRefresh(key, reason, options) {
    const generation = (this.refreshes.get(key)?.generation ?? 0) + 1;
    const request = this.runRefresh(key, reason, generation);
    const tracked = Object.assign(request, { generation });
    this.refreshes.set(key, tracked);
    return tracked;
  }

  async runRefresh(key, reason, generation) {
    try {
      const value = await this.fetcher(key, { reason, generation });
      if (this.refreshes.get(key)?.generation !== generation) {
        return this.refreshes.get(key) ?? {
          key,
          value: this.records.get(key)?.value ?? this.fallbackValue,
          source: 'stale-cache'
        };
      }
      if (!this.impl && this.worker) {
        return this.set(key, value, this.defaultTtl, reason);
      }
      return { key, value, source: 'remote', stale: false };
    } catch (error) {
      if (this.refreshes.get(key)?.generation !== generation) {
        return this.refreshes.get(key) ?? {
          key,
          value: this.records.get(key)?.value ?? this.fallbackValue,
          source: 'stale-cache'
        };
      }
      if (!this.impl && this.worker) {
        this.worker.postMessage({ type: 'REVALIDATE_ERROR', key, error: error.message });
      }
      this.emitError('fetch', error, { key, reason });
      const stale = this.records.get(key);
      return {
        key,
        value: stale?.value ?? this.fallbackValue,
        source: stale ? 'stale-cache' : 'fallback',
        stale: Boolean(stale),
        error
      };
    } finally {
      if (this.refreshes.get(key) === request) {
        this.refreshes.delete(key);
      }
    }
  }

  resolvePending(requestId, value) {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }
    this.pending.delete(requestId);
    pending.resolve(value);
  }

  nextRequestId() {
    this.requestId += 1;
    return this.requestId;
  }

  getSnapshot() {
    return new Map(this.records);
  }

  close() {
    if (this.impl) {
      this.impl.close();
    }
    this.worker?.terminate();
    this.worker = null;
  }

  forward(reason, detail = {}) {
    this.dispatchEvent(new CustomEvent('state', {
      detail: {
        reason,
        mode: this.mode,
        records: this.getSnapshot(),
        ...detail
      }
    }));
  }

  emitError(scope, error, detail = {}) {
    this.dispatchEvent(new CustomEvent('error', {
      detail: {
        scope,
        error: error instanceof Error ? error : new Error(String(error)),
        mode: this.mode,
        records: this.getSnapshot(),
        ...detail
      }
    }));
  }
}
