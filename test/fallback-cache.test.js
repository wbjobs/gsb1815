import test from 'node:test';
import assert from 'node:assert/strict';
import { FallbackPermissionCache } from '../src/fallback-cache.js';
import { FakeBroadcastChannel, createClock, flush } from './helpers.js';

async function createFallback(options = {}) {
  const channelName = options.channelName ?? `test-${Math.random()}`;
  const clock = createClock();
  let version = 1;
  let shouldFail = Boolean(options.failOnce);
  let failureCount = options.failOnce ? 1 : 0;
  const fetchCalls = [];
  const cache = new FallbackPermissionCache({
    defaultTtl: options.ttl ?? 500,
    fallbackValue: { allowed: false, permissions: [] },
    channelFactory: () => new FakeBroadcastChannel(channelName),
    channelName,
    now: clock.now,
    setIntervalFn: clock.setInterval,
    clearIntervalFn: clock.clearInterval,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    fetcher: async (key, context) => {
      fetchCalls.push(context.reason);
      await flush(0);
      if (failureCount > 0) {
        failureCount -= 1;
        throw new Error('network down');
      }
      version += 1;
      return { allowed: true, permissions: ['read'], version };
    }
  });

  const states = [];
  const errors = [];
  cache.addEventListener('state', (event) => states.push(event.detail));
  cache.addEventListener('error', (event) => errors.push(event.detail));
  await cache.init();

  return { cache, clock, fetchCalls, states, errors };
}

test.beforeEach(() => FakeBroadcastChannel.reset());

test('降级模式支持缓存、TTL 与后台重新校验', async () => {
  const instance = await createFallback({ ttl: 500 });

  const first = await instance.cache.refresh('perm', { reason: 'manual' });
  assert.equal(first.source, 'remote');
  assert.equal(first.value.version, 2);

  instance.clock.advance(499);
  const cached = await instance.cache.get('perm');
  assert.equal(cached.source, 'cache');
  assert.equal(instance.fetchCalls.length, 1);

  instance.clock.advance(1);
  const stale = await instance.cache.get('perm');
  assert.equal(stale.source, 'stale-cache');
  await flush();

  assert.deepEqual(instance.fetchCalls, ['manual', 'ttl']);
});

test('失效立即广播并强制重新校验', async () => {
  const channelName = `broadcast-${Math.random()}`;
  const first = await createFallback({ channelName });
  const second = await createFallback({ channelName });

  await first.cache.refresh('perm', { reason: 'manual' });
  await second.cache.refresh('perm', { reason: 'manual' });
  second.states.length = 0;

  await first.cache.invalidate('perm', 'manual');
  await flush();

  const broadcastState = second.states.find((state) => state.reason === 'broadcast');
  assert.equal(broadcastState.records.get('perm').stale, true);
  assert.equal(second.fetchCalls.at(-1), 'broadcast');
});

test('接口异常时返回旧值或默认降级权限并提示', async () => {
  const withStale = await createFallback();
  await withStale.cache.refresh('perm', { reason: 'manual' });
  withStale.errors.length = 0;
  let threw = false;
  withStale.cache.fetcher = async () => {
    if (!threw) {
      threw = true;
      throw new Error('network down');
    }
    return { allowed: true };
  };
  const failed = await withStale.cache.refresh('perm', { reason: 'manual' });
  assert.equal(failed.source, 'stale-cache');
  assert.equal(withStale.errors[0].scope, 'fetch');

  const cold = await createFallback({ failOnce: true });
  const coldFailed = await cold.cache.refresh('cold', { reason: 'manual' });
  assert.equal(coldFailed.source, 'fallback');
  assert.equal(coldFailed.value.allowed, false);
  assert.equal(cold.errors[0].scope, 'fetch');
});

test('失效时进行中的旧请求不会覆盖新请求结果', async () => {
  FakeBroadcastChannel.reset();
  const channelName = `race-${Math.random()}`;
  const calls = [];
  const clock = createClock();
  let resolveOld;
  const oldRequest = new Promise((resolve) => {
    resolveOld = resolve;
  });
  const cache = new FallbackPermissionCache({
    channelName,
    channelFactory: () => new FakeBroadcastChannel(channelName),
    fallbackValue: { allowed: false, permissions: [] },
    now: clock.now,
    setIntervalFn: clock.setInterval,
    clearIntervalFn: clock.clearInterval,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    fetcher: async (key, context) => {
      if (context.generation === 1) {
        await oldRequest;
        return { version: 'old' };
      }
      calls.push(context.reason);
      return { version: 'new' };
    }
  });

  await cache.init();
  const first = cache.refresh('perm', { reason: 'ttl', force: false });
  const second = cache.refresh('perm', { reason: 'invalidate', force: true });
  resolveOld({ version: 'old' });
  await flush();

  await Promise.all([first, second]);
  assert.equal(cache.getSnapshot().get('perm').value.version, 'new');
  assert.equal(calls.at(-1), 'invalidate');
  cache.close();
});
