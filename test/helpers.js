export class FakeBroadcastChannel {
  static channels = new Map();

  constructor(name) {
    this.name = name;
    this.onmessage = null;
    if (!FakeBroadcastChannel.channels.has(name)) {
      FakeBroadcastChannel.channels.set(name, new Set());
    }
    FakeBroadcastChannel.channels.get(name).add(this);
  }

  postMessage(message) {
    for (const channel of FakeBroadcastChannel.channels.get(this.name)) {
      if (channel !== this && channel.onmessage) {
        channel.onmessage({ data: structuredClone(message) });
      }
    }
  }

  close() {
    FakeBroadcastChannel.channels.get(this.name)?.delete(this);
  }

  static reset() {
    FakeBroadcastChannel.channels.clear();
  }
}

export class FakeStore {
  constructor(initialRecords = []) {
    this.records = new Map(initialRecords);
    this.sets = [];
  }

  async open() {}

  async getAll() {
    return new Map(this.records);
  }

  async get(key) {
    return this.records.get(key);
  }

  async set(key, value) {
    this.sets.push([key, structuredClone(value)]);
    this.records.set(key, structuredClone(value));
  }

  async delete(key) {
    this.records.delete(key);
  }

  async close() {}
}

export function createClock(start = 1000) {
  let now = start;
  const timers = new Map();
  const timeouts = new Map();
  let timerId = 0;

  return {
    now: () => now,
    setInterval(callback) {
      timerId += 1;
      timers.set(timerId, callback);
      return timerId;
    },
    clearInterval(id) {
      timers.delete(id);
    },
    setTimeout(callback, delay = 0) {
      timerId += 1;
      timeouts.set(timerId, { callback, runAt: now + delay });
      return timerId;
    },
    clearTimeout(id) {
      timeouts.delete(id);
    },
    advance(ms) {
      now += ms;
      timers.forEach((callback) => callback());
      timeouts.forEach((timeout, id) => {
        if (timeout.runAt <= now) {
          timeouts.delete(id);
          timeout.callback();
        }
      });
    }
  };
}

export function flush(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
