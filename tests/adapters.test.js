import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { IdbStorage, MemoryStorage } from '../src/adapters.js';
import { PermissionCache } from '../src/core.js';
import { FakeClock, FakeHub, FakeBroadcaster, countingFetch } from './fakes.js';
import { installIndexedDB, uninstallIndexedDB } from './idb-mock.js';

let clock;
function make(storage) {
  clock = new FakeClock();
  const cf = countingFetch();
  const cache = new PermissionCache(
    { storage, scheduler: clock, broadcaster: new FakeBroadcaster(new FakeHub()) },
    { ttl: 10_000, fetchPermission: cf.fetch }
  );
  return { cache, cf };
}

beforeEach(() => installIndexedDB());
afterEach(() => uninstallIndexedDB());

test('IdbStorage：set/get/keys/delete 真实事务路径', async () => {
  const s = new IdbStorage();
  await s.set('a', { x: 1 });
  assert.deepEqual(await s.get('a'), { x: 1 });
  assert.deepEqual(await s.keys(), ['a']);
  await s.delete('a');
  assert.equal(await s.get('a'), undefined);
});

test('IdbStorage 持久化跨实例：新实例 warm 后命中缓存不回源', async () => {
  const s1 = new IdbStorage();
  const { cache: c1, cf } = make(s1);
  await c1.get('p1');
  assert.equal(cf.calls.length, 1);

  const s2 = new IdbStorage();
  const { cache: c2, cf: cf2 } = make(s2);
  await c2.warm();
  const r = await c2.get('p1');
  assert.equal(r.state, 'fresh');
  assert.equal(cf2.calls.length, 0); // 第二实例直接吃 IndexedDB 持久数据
});

test('IndexedDB open 失败：IdbStorage 抛 degrade 事件，核心自动降级内存', async () => {
  uninstallIndexedDB();
  installIndexedDB({ failOpen: true });
  const s = new IdbStorage();
  const deg = [];
  s.on('degrade', (p) => deg.push(p));
  const { cache, cf } = make(s);
  cache.on('degrade', (p) => deg.push({ core: true, ...p }));
  const r = await cache.get('k');
  assert.equal(r.state, 'remote');
  assert.ok(deg.some((p) => p.layer === 'storage'));
  assert.equal(cf.calls.length, 1);
});

test('MemoryStorage 基础读写', async () => {
  const m = new MemoryStorage();
  await m.set('x', { a: 1 });
  assert.deepEqual(await m.get('x'), { a: 1 });
  assert.deepEqual(await m.keys(), ['x']);
});
