export class FakeStorage {
  constructor(map = new Map()) { this.map = map; this.fail = false; }
  async get(k) { this.#maybeFail(); const v = this.map.get(k); return v ? JSON.parse(JSON.stringify(v)) : undefined; }
  async set(k, v) { this.#maybeFail(); this.map.set(k, JSON.parse(JSON.stringify(v))); }
  async delete(k) { this.map.delete(k); }
  async keys() { return [...this.map.keys()]; }
  #maybeFail() { if (this.fail) throw new Error('存储故障'); }
}

export class FakeClock {
  constructor() { this.t = 0; this.q = []; this.seq = 0; this.gen = 0; }
  now() { return this.t; }
  setTimeout(fn, delay) {
    const id = ++this.seq;
    this.q.push({ id, at: this.t + Math.max(0, delay), fn, gen: this._advGen ?? 0 });
    return { id };
  }
  clearTimeout(h) { if (h) this.q = this.q.filter((x) => x.id !== h.id); }
  async advance(ms, opts = {}) {
    const until = this.t + ms;
    const baseGen = this.gen;
    this._advGen = this.gen + 1; // 推进期间登记的定时器属于“推进产物”
    // 本次只处理推进开始前已存在（gen<=baseGen）且到期的定时器。
    for (;;) {
      const item = this.q
        .filter((x) => x.gen <= baseGen && x.at <= until)
        .sort((a, b) => a.at - b.at)[0];
      if (!item) break;
      this.q = this.q.filter((x) => x !== item);
      this.t = item.at;
      item.fn();
      if (opts.settle !== false) await microtasks(30);
    }
    this._advGen = 0;
    this.gen++;
    this.t = until;
  }
}

const microtasks = (n) => new Promise((r) => {
  let i = 0;
  const step = () => (i++ < n ? Promise.resolve().then(step) : r());
  step();
});

export class FakeHub {
  constructor() { this.peers = new Set(); }
  register(b) { this.peers.add(b); }
  unregister(b) { this.peers.delete(b); }
  dispatch(sender, topic, msg) {
    for (const p of this.peers) if (p !== sender) p._deliver(topic, msg);
  }
}

export class FakeBroadcaster {
  constructor(hub) { this.hub = hub; this.h = new Map(); hub.register(this); }
  on(t, fn) { (this.h.get(t) ?? this.h.set(t, new Set()).get(t)).add(fn); }
  emit(t, p) { this.h.get(t)?.forEach((fn) => fn(p)); }
  post(topic, msg) { this.hub.dispatch(this, topic, msg); }
  _deliver(topic, msg) { this.emit(topic, msg); }
  close() { this.hub.unregister(this); }
}

export function countingFetch(opts = {}) {
  const calls = [];
  const failKeys = opts.failKeys instanceof Set ? opts.failKeys : new Set(opts.failKeys || []);
  const values = opts.values || {};
  return {
    calls,
    failKeys,
    fetch: async (key) => {
      calls.push(key);
      await Promise.resolve();
      if (failKeys.has(key)) throw new Error('回源失败:' + key);
      values[key] = (values[key] || 0) + 1;
      return { allowed: true, v: values[key] };
    },
  };
}
