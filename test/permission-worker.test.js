import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionWorkerContext } from '../src/permission-worker.js';
import { FakeBroadcastChannel, FakeStore, createClock, flush } from './helpers.js';

function createWorker(options = {}) {
  const messages = [];
  const clock = createClock();
  const store = new FakeStore(options.records ?? []);
  let messageHandler = null;

  const context = new PermissionWorkerContext({
    storeFactory: () => store,
    fallbackStoreFactory: () => new FakeStore(),
    channelFactory: (name) => new FakeBroadcastChannel(name),
    now: clock.now,
    setIntervalFn: clock.setInterval,
    clearIntervalFn: clock.clearInterval,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    postMessage: (message) => {
      messages.push(message);
    },
    onMessage: (handler) => {
      messageHandler = handler;
    }
  });

  return {
    context,
    store,
    clock,
    messages,
    send(message) {
      return messageHandler(message);
    },
    async start() {
      await context.start();
      messages.length = 0;
    }
  };
}

test('TTL 到期后标记旧缓存并立即请求重新校验', async () => {
  FakeBroadcastChannel.reset();
  const worker = createWorker({
    records: [['perm', {
      value: { allowed: true },
      cachedAt: 1000,
      expiresAt: 1500,
      ttl: 500,
      stale: false
    }]]
  });
  await worker.start();

  worker.clock.advance(499);
  assert.equal(worker.context.records.get('perm').stale, false);

  worker.clock.advance(1);
  assert.equal(worker.context.records.get('perm').stale, true);
  assert.equal(worker.context.records.get('perm').expiresAt, 1500);
  assert.equal(worker.messages.some((message) => message.type === 'TTL_EXPIRED'), true);
  const ttlRefresh = worker.messages.find((message) => message.type === 'REVALIDATE');
  assert.equal(ttlRefresh.key, 'perm');
  assert.equal(ttlRefresh.reason, 'ttl');
});

test('本地失效会持久化、广播，并在 SET 成功后完成', async () => {
  FakeBroadcastChannel.reset();
  const worker = createWorker({
    records: [['perm', {
      value: { version: 1 },
      cachedAt: 1000,
      expiresAt: 2000,
      ttl: 1000,
      stale: false
    }]]
  });
  let completed;
  const completion = worker.context.requestRevalidation;
  worker.context.requestRevalidation = async function(...args) {
    completed = completion.apply(this, args);
    return completed;
  };
  await worker.start();

  worker.send({ type: 'INVALIDATE', requestId: 7, key: 'perm', reason: 'manual' });
  await flush();

  assert.equal(worker.context.records.get('perm').stale, true);
  assert.equal(worker.store.sets.at(-1)[1].stale, true);
  assert.equal(worker.messages.some((message) => message.type === 'INVALIDATED'), true);
  assert.equal(worker.messages.some((message) => message.type === 'INVALIDATION_COMPLETE'), false);

  await worker.send({
    type: 'SET',
    key: 'perm',
    value: { version: 2 },
    ttl: 1000,
    reason: 'invalidate'
  });
  await completed;
  await flush();

  const response = worker.messages.find((message) => message.type === 'INVALIDATION_COMPLETE');
  assert.equal(response.requestId, 7);
  assert.deepEqual(response.matchedKeys, ['perm']);
  assert.equal(worker.context.records.get('perm').stale, false);
  assert.equal(worker.context.records.get('perm').value.version, 2);
});

test('收到其他上下文广播后立即失效并重新校验', async () => {
  FakeBroadcastChannel.reset();
  const workerA = createWorker();
  const workerB = createWorker();
  await workerA.start();
  await workerB.start();

  workerB.context.records.set('perm', {
    value: { version: 1 },
    cachedAt: 1000,
    expiresAt: 5000,
    ttl: 4000,
    stale: false
  });

  await workerA.send({ type: 'INVALIDATE', key: 'perm', reason: 'manual' });
  await flush();

  assert.equal(workerB.context.records.get('perm').stale, true);
  assert.equal(workerB.messages.some((message) => message.type === 'REMOTE_INVALIDATED'), true);
  const remoteRefresh = workerB.messages.find((message) => message.type === 'REVALIDATE');
  assert.equal(remoteRefresh.key, 'perm');
  assert.equal(remoteRefresh.reason, 'broadcast');
});

test('IndexedDB 不可用时切换内存存储并发送异常提示', async () => {
  FakeBroadcastChannel.reset();
  const messages = [];
  const clock = createClock();
  const context = new PermissionWorkerContext({
    storeFactory: () => ({
      async open() {},
      async getAll() { throw new Error('IDB blocked'); },
      async set() {}
    }),
    fallbackStoreFactory: () => new FakeStore(),
    channelFactory: (name) => new FakeBroadcastChannel(name),
    now: clock.now,
    setIntervalFn: clock.setInterval,
    clearIntervalFn: clock.clearInterval,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    postMessage: (message) => messages.push(message),
    onMessage: () => {}
  });

  await context.start();
  assert.equal(messages.some((message) => message.type === 'WORKER_ERROR' && message.scope === 'indexeddb'), true);
  assert.equal(messages.at(-1).type, 'WORKER_READY');
});
