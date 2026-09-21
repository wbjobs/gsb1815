import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionCache } from '../src/permission-cache.js';
import { FakeBroadcastChannel } from './helpers.js';

test.beforeEach(() => FakeBroadcastChannel.reset());

test('Worker 创建失败时自动降级并保持权限读取可用', async () => {
  const originalBroadcastChannel = globalThis.BroadcastChannel;
  globalThis.BroadcastChannel = FakeBroadcastChannel;

  try {
    const errors = [];
    const states = [];
    const cache = new PermissionCache({
      workerFactory: () => {
        throw new Error('worker blocked');
      },
      defaultTtl: 1000,
      fetcher: async () => ({ allowed: true, permissions: ['read'] }),
      fallbackValue: { allowed: false, permissions: [] }
    });

    cache.addEventListener('error', (event) => errors.push(event.detail));
    cache.addEventListener('state', (event) => states.push(event.detail.reason));

    await cache.init();
    assert.equal(cache.mode, 'fallback');
    assert.equal(errors[0].scope, 'worker-start');

    const result = await cache.refresh('perm', { reason: 'manual' });
    assert.equal(result.source, 'remote');
    assert.equal(result.value.allowed, true);

    const cached = await cache.get('perm');
    assert.equal(cached.source, 'cache');
    assert.equal(states.includes('manual'), true);
    cache.close();
  } finally {
    globalThis.BroadcastChannel = originalBroadcastChannel;
  }
});

test('Worker 运行时崩溃会把等待中的请求切到降级缓存', async () => {
  const originalBroadcastChannel = globalThis.BroadcastChannel;
  globalThis.BroadcastChannel = FakeBroadcastChannel;

  class FakeWorker extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => {
        this.onmessage?.({ data: { type: 'WORKER_READY', cacheMode: 'worker', records: new Map() } });
      });
    }

    postMessage(message) {
      if (message.type === 'GET') {
        queueMicrotask(() => {
          this.onerror({ message: 'runtime crash' });
        });
      }
    }

    terminate() {}
  }

  try {
    const cache = new PermissionCache({
      workerFactory: () => new FakeWorker(),
      defaultTtl: 1000,
      fetcher: async () => ({ allowed: true, permissions: ['runtime-read'] })
    });

    await cache.init();
    assert.equal(cache.mode, 'worker');

    const result = await cache.get('runtime-perm');
    assert.equal(cache.mode, 'fallback');
    assert.equal(result.value.allowed, true);
    assert.deepEqual(result.value.permissions, ['runtime-read']);
    cache.close();
  } finally {
    globalThis.BroadcastChannel = originalBroadcastChannel;
  }
});
