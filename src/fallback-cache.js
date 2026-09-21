import { keyMatches } from './idb-store.js';

const CHANNEL_NAME = 'permission-cache';
const TTL_SWEEP_MS = 1000;

export class FallbackPermissionCache extends EventTarget {
  constructor(options = {}) {
    super();
    this.fetcher = options.fetcher;
    this.defaultTtl = options.defaultTtl ?? 30000;
    this.fallbackValue = options.fallbackValue ?? { allowed: false, permissions: [] };
    this.channelName = options.channelName ?? CHANNEL_NAME;
    this.now = options.now ?? (() => Date.now());
    this.setIntervalFn = options.setIntervalFn ?? globalThis.setInterval;
    this.clearIntervalFn = options.clearIntervalFn ?? globalThis.clearInterval;
    this.channelFactory = options.channelFactory ?? ((name) => new BroadcastChannel(name));
    this.records = new Map();
    this.inFlight = new Map();
    this.generations = new Map();
    this.channel = null;
    this.mode = 'fallback';
    this.sweepTimer = null;
    this.timers = new Map();
    this.setTimeoutFn = options.setTimeoutFn ?? globalThis.setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? globalThis.clearTimeout;
  }

  async init() {
    try {
      this.channel = this.channelFactory(this.channelName);
      this.channel.onmessage = (event) => this.handleBroadcast(event.data);
    } catch (error) {
      this.channel = null;
      this.emitError('broadcast', error);
    }

    this.sweepTimer = this.setIntervalFn(() => this.sweepExpired(), TTL_SWEEP_MS);
    this.emitState('ready');
    return this;
  }

  async get(key) {
    const record = this.records.get(key);
    if (!record) {
      return this.refresh(key, { reason: 'cold-start', force: true });
    }

    if (!record.stale && (record.expiresAt === 0 || record.expiresAt > this.now())) {
      return {
        status: 'fresh',
        key,
        value: record.value,
        record,
        source: 'cache'
      };
    }

    if (record.stale && record.expiresAt !== 0 && record.expiresAt <= this.now()) {
      this.refresh(key, { reason: 'ttl', force: false }).catch(() => {});
      return {
        status: 'stale',
        key,
        value: record.value,
        record,
        source: 'stale-cache'
      };
    }

    this.refresh(key, { reason: record.stale ? 'stale' : 'ttl', force: false }).catch(() => {});
    return {
      status: 'stale',
      key,
      value: record.value,
      record,
      source: 'stale-cache'
    };
  }

  async refresh(key, options = {}) {
    const reason = options.reason ?? 'manual';
    const force = options.force ?? true;
    const existing = this.inFlight.get(key);

    if (existing && !force) {
      return existing;
    }
    return this.startFetch(key, reason);
  }

  startFetch(key, reason) {
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    const request = this.runFetch(key, reason, generation)
      .finally(() => {
        if (this.inFlight.get(key) === request) {
          this.inFlight.delete(key);
        }
      });

    this.inFlight.set(key, request);
    return request;
  }

  async runFetch(key, reason, generation) {
    try {
      const value = await this.fetcher(key, { reason, generation });
      if (this.generations.get(key) !== generation) {
        return this.inFlight.get(key) ?? { key, value: this.records.get(key)?.value ?? value, source: 'stale-cache' };
      }
      this.applySet(key, value, this.defaultTtl, reason, 'local');
      return { key, value, source: 'remote', stale: false };
    } catch (error) {
      if (this.generations.get(key) !== generation) {
        return this.inFlight.get(key) ?? { key, value: this.records.get(key)?.value ?? this.fallbackValue, source: 'stale-cache' };
      }
      this.emitError('fetch', error, { key, reason });
      return {
        key,
        value: this.records.get(key)?.value ?? this.fallbackValue,
        source: this.records.has(key) ? 'stale-cache' : 'fallback',
        stale: this.records.has(key),
        error
      };
    }
  }

  applySet(key, value, ttl, reason, origin) {
    const now = this.now();
    const record = {
      value,
      cachedAt: now,
      expiresAt: ttl > 0 ? now + ttl : 0,
      ttl,
      stale: false,
      source: 'remote'
    };
    this.records.set(key, record);
    this.scheduleExpiry(key, record);
    this.emitState(reason, { key, record, origin });
    return record;
  }

  async set(key, value, ttl = this.defaultTtl) {
    const record = this.applySet(key, value, ttl, 'set', 'local');
    return { key, value: record.value, source: 'remote', stale: false };
  }

  async invalidate(key, reason = 'manual') {
    const now = this.now();
    const matchedKeys = [];

    for (const [cachedKey, record] of this.records) {
      if (keyMatches(cachedKey, key)) {
        const nextRecord = { ...record, stale: true, expiresAt: now, invalidatedAt: now };
        this.records.set(cachedKey, nextRecord);
        this.clearExpiry(cachedKey);
        matchedKeys.push(cachedKey);
      }
    }

    this.broadcast({ type: 'INVALIDATE', key, reason, at: now });
    this.emitState('invalidate', { key, matchedKeys });

    await Promise.all(matchedKeys.map((matchedKey) => {
      return this.refresh(matchedKey, {
      reason: 'invalidate',
      force: true
      });
    }));

    return { key, matchedKeys };
  }

  handleBroadcast(message) {
    if (!message || message.type !== 'INVALIDATE') {
      return;
    }

    const now = this.now();
    const matchedKeys = [];
    for (const [key, record] of this.records) {
      if (keyMatches(key, message.key)) {
        this.records.set(key, { ...record, stale: true, expiresAt: now, invalidatedAt: now });
        this.clearExpiry(key);
        matchedKeys.push(key);
      }
    }

    this.emitState('broadcast', {
      key: message.key,
      matchedKeys,
      originClientId: message.originClientId
    });
    matchedKeys.forEach((key) => this.refresh(key, { reason: 'broadcast', force: true }).catch(() => {}));
  }

  broadcast(message) {
    if (!this.channel) {
      this.emitError('broadcast', new Error('BroadcastChannel is unavailable'));
      return;
    }
    this.channel.postMessage({ ...message, originClientId: 'fallback' });
  }

  sweepExpired() {
    const now = this.now();
    for (const [key, record] of this.records) {
      if (!record.stale && record.expiresAt !== 0 && record.expiresAt <= now) {
        this.records.set(key, { ...record, stale: true, expiresAt: now });
        this.clearExpiry(key);
        this.emitState('ttl', { key });
        this.refresh(key, { reason: 'ttl', force: false }).catch(() => {});
      }
    }
  }

  getSnapshot() {
    return new Map(this.records);
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

  close() {
    if (this.sweepTimer !== null) {
      this.clearIntervalFn(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.timers.forEach((timer) => this.clearTimeoutFn(timer));
    this.timers.clear();
    this.channel?.close();
    this.channel = null;
  }

  emitState(reason, detail = {}) {
    this.dispatchEvent(new CustomEvent('state', {
      detail: {
        reason,
        records: this.getSnapshot(),
        mode: this.mode,
        ...detail
      }
    }));
  }

  emitError(scope, error, detail = {}) {
    this.dispatchEvent(new CustomEvent('error', {
      detail: {
        scope,
        error: error instanceof Error ? error : new Error(String(error)),
        records: this.getSnapshot(),
        mode: this.mode,
        ...detail
      }
    }));
  }
}
