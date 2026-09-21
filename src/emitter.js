export class EmitterLite {
  constructor() { this._h = new Map(); }
  on(type, fn) {
    if (!this._h.has(type)) this._h.set(type, new Set());
    this._h.get(type).add(fn);
    return () => this._h.get(type)?.delete(fn);
  }
  emit(type, payload) {
    this._h.get(type)?.forEach((fn) => { try { fn(payload); } catch { /* listener 隔离 */ } });
  }
}
