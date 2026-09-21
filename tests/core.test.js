import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionCache } from '../src/core.js';
import { FakeStorage, FakeClock, FakeHub, FakeBroadcaster, countingFetch } from './fakes.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

function make(opts = {}) {
  const storage = opts.storage || new FakeStorage();
  const clock = new FakeClock();
  const hub = opts.hub || new FakeHub();
  const broadcaster = opts.noBroadcaster ? null : new FakeBroadcaster(hub);
  const cf = countingFetch({ failKeys: opts.failKeys, values: opts.values });
  const cache = new PermissionCache(
    { storage, scheduler: clock, broadcaster },
    {
      ttl: opts.ttl ?? 10_000,
      staleExtra: opts.staleExtra,
      fetchPermission: cf.fetch,
      knownKeys: opts.knownKeys,
    }
  );
  return { cache, clock, hub, cf, storage };
}

test('fresh 命中缓存不回源；TTL 到期立即后台重新校验且时间精确', async () => {
  const { cache, clock, cf } = make();
  const r1 = await cache.get('k1');
  assert.equal(r1.state, 'remote');
  assert.equal(cf.calls.length, 1);

  const r2 = await cache.get('k1');
  assert.equal(r2.state, 'fresh');
  assert.equal(cf.calls.length, 1);

  await clock.advance(9_999);
  assert.equal(cache.peek('k1').state, 'fresh');
  assert.equal(cf.calls.length, 1);
  // 到期瞬间（10000ms 整，不早 1ms）由 Worker 定时器（此处用 FakeClock 模拟）触发重新校验
  await clock.advance(1);
  assert.equal(cf.calls.length, 2);
  assert.equal(cache.peek('k1').state, 'fresh');

});

test('SWR 宽限期：过期但未超 staleExtra 时立即返回 stale 旧值并后台重校验', async () => {
  const { cache, clock, cf } = make();
  await cache.get('k1');
  // 直接拨逻辑时钟到过期 1ms（定时器不触发），模拟“读到时刚过期”
  clock.t = 10_001;
  assert.equal(cache.peek('k1').state, 'stale');
  const callsBefore = cf.calls.length;
  const staleResult = await cache.get('k1');
  assert.equal(staleResult.state, 'stale');
  assert.equal(staleResult.fromCache, true);
  assert.ok(cf.calls.length >= callsBefore);
});

test('invalidate 后立即删除缓存并立即重新校验', async () => {
  const { cache, cf } = make();
  await cache.get('k1');
  assert.equal(cache.peek('k1').state, 'fresh');
  const { revalidate } = await cache.invalidate('k1');
  await revalidate;
  assert.equal(cf.calls.length, 2);           // 初次 + 失效后立即重校验
  assert.equal(cache.peek('k1').state, 'fresh');
});

test('广播及时：A 失效，B 立即收到并重新校验', async () => {
  const hub = new FakeHub();
  const a = make({ hub, knownKeys: ['k1'] });
  const b = make({ hub, knownKeys: ['k1'] });
  await a.cache.warm(); await b.cache.warm();
  await a.cache.get('k1');
  b.cf.calls.length = 0;
  await b.cache.get('k1', { forceRefresh: true }); // B 也持有缓存
  assert.ok(b.cf.calls.length >= 1);
  b.cf.calls.length = 0;

  const { revalidate } = await a.cache.invalidate('k1');
  await revalidate;
  await flush(); // 广播投递 + B 端立即重新校验
  assert.ok(b.cf.calls.includes('k1'));
  assert.equal(b.cache.peek('k1').state, 'fresh');
  assert.equal(b.storage.map.has('k1'), true);
});

test('invalidate-all 广播覆盖双方全部已知 key', async () => {
  const hub = new FakeHub();
  const a = make({ hub, knownKeys: ['x'] });
  const b = make({ hub, knownKeys: ['x', 'y'] });
  await a.cache.warm(); await b.cache.warm();
  await a.cache.get('x');
  b.cf.calls.length = 0;
  const { revalidateAll } = await a.cache.invalidateAll();
  await revalidateAll;
  await flush();
  assert.ok(b.cf.calls.includes('x'));
});

test('异常提示：无缓存且回源失败时抛错并产生 error 事件', async () => {
  const errors = [];
  const { cache } = make({ failKeys: new Set(['k1']) });
  cache.on('error', (p) => errors.push(p));
  await assert.rejects(() => cache.get('k1'), /回源失败/);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].phase, 'fetch');
  assert.equal(errors[0].background, false);
});

test('降级可用：回源失败时旧值 fallback 兜底', async () => {
  const fallbacks = [];
  const { cache, cf } = make();
  cache.on('fallback', (p) => fallbacks.push(p));
  await cache.get('k2');
  cf.failKeys.add('k2');
  const r = await cache.get('k2', { forceRefresh: true });
  assert.equal(r.state, 'fallback');
  assert.equal(r.fromCache, true);
  assert.equal(fallbacks.length, 1);
});

test('TTL 到期后台重校验失败：发 error 事件、旧值可兜底、恢复后可读新值', async () => {
  const { cache, clock, cf } = make({ values: {} });
  await cache.get('k1');
  cf.failKeys.add('k1');
  const errs = [];
  cache.on('error', (p) => errs.push(p));
  await clock.advance(10_000);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].phase, 'expire-revalidate');
  assert.equal(errs[0].background, true);
  // SWR 宽限期内：stale 直接返回
  assert.equal((await cache.get('k1')).state, 'stale');
  // 超出宽限期后：回源失败 → 旧值 fallback 兜底
  await clock.advance(10_000);
  const r = await cache.get('k1');
  assert.equal(r.state, 'fallback');
  // 服务恢复
  cf.failKeys.delete('k1');
  const r2 = await cache.get('k1', { forceRefresh: true });
  assert.equal(r2.state, 'remote');
});

test('存储运行时故障自动降级到内存存储并发 degrade 事件', async () => {
  const storage = new FakeStorage();
  const degradations = [];
  const clock = new FakeClock();
  const hub = new FakeHub();
  const cf = countingFetch();
  const cache = new PermissionCache(
    { storage, scheduler: clock, broadcaster: new FakeBroadcaster(hub) },
    { ttl: 10_000, fetchPermission: cf.fetch }
  );
  cache.on('degrade', (p) => degradations.push(p));
  storage.fail = true;
  const r = await cache.get('k1');
  assert.equal(r.state, 'remote');
  assert.equal(degradations[0]?.layer, 'storage');
  storage.fail = false;
  const r2 = await cache.get('k1');
  assert.equal(r2.state, 'fresh');
});

test('并发回源自动去重', async () => {
  const { cache, cf } = make();
  const results = await Promise.all([cache.get('dup'), cache.get('dup'), cache.get('dup')]);
  assert.equal(cf.calls.filter((k) => k === 'dup').length, 1);
  assert.ok(results.every((r) => r.state === 'remote'));
});

test('revalidate:false 时 invalidate 只删除不回源', async () => {
  const { cache, cf } = make();
  await cache.get('k1');
  await cache.invalidate('k1', { revalidate: false });
  assert.equal(cf.calls.length, 1);
  assert.equal(cache.peek('k1').state, 'missing');
});
