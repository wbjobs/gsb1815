export class MemoryPermissionStore {
  constructor(initialRecords = new Map()) {
    this.records = new Map(initialRecords);
  }

  async open() {}

  async getAll() {
    return new Map(this.records);
  }

  async get(key) {
    const value = this.records.get(key);
    return value === undefined ? undefined : structuredCloneLike(value);
  }

  async set(key, value) {
    this.records.set(key, structuredCloneLike(value));
  }

  async delete(key) {
    this.records.delete(key);
  }

  async close() {}
}

function structuredCloneLike(value) {
  if (value === undefined) {
    return value;
  }
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}
