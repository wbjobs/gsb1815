const STATE_KEY = 'permission-demo:state';

const DEFAULT_PERMISSIONS = {
  'permission:demo': {
    allowed: true,
    permissions: ['document:read', 'document:comment'],
    version: 1
  }
};

export class MockPermissionApi {
  constructor(options = {}) {
    this.delay = options.delay ?? 350;
    this.storage = options.storage ?? globalThis.localStorage;
    this.now = options.now ?? (() => Date.now());
    this.failNext = 0;
  }

  async fetchPermissions(key, context = {}) {
    await wait(this.delay);
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('模拟权限接口异常');
    }

    const state = this.readState();
    return {
      ...state[key],
      fetchedAt: this.now(),
      requestReason: context.reason ?? 'unknown'
    };
  }

  grant(permission) {
    const state = this.readState();
    const current = state['permission:demo'];
    const permissions = new Set(current.permissions);
    permissions.add(permission);
    state['permission:demo'] = {
      allowed: true,
      permissions: [...permissions],
      version: current.version + 1
    };
    this.writeState(state);
  }

  revoke(permission) {
    const state = this.readState();
    const current = state['permission:demo'];
    state['permission:demo'] = {
      allowed: current.allowed,
      permissions: current.permissions.filter((item) => item !== permission),
      version: current.version + 1
    };
    this.writeState(state);
  }

  failOnce(times = 1) {
    this.failNext = times;
  }

  readState() {
    if (!this.storage) {
      return structuredCloneLike(DEFAULT_PERMISSIONS);
    }
    try {
      const raw = this.storage.getItem(STATE_KEY);
      return raw ? JSON.parse(raw) : structuredCloneLike(DEFAULT_PERMISSIONS);
    } catch {
      return structuredCloneLike(DEFAULT_PERMISSIONS);
    }
  }

  writeState(state) {
    if (this.storage) {
      this.storage.setItem(STATE_KEY, JSON.stringify(state));
    }
  }

  reset() {
    this.failNext = 0;
    if (this.storage) {
      this.storage.removeItem(STATE_KEY);
    }
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function structuredCloneLike(value) {
  return JSON.parse(JSON.stringify(value));
}
