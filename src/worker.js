/*
 * TTL Web Worker：
 * - 在 worker 线程计时，不受主线程任务阻塞影响；
 * - 延时分片，规避 setTimeout 32bit 上限；
 * - 时间戳由 worker 内 Date.now() 核对，到期回主线程触发重新校验。
 */
const TIMER_CHUNK = 2_147_000_000;
const timers = new Map();
let seq = 0;

function schedule(id, delay) {
  const startedAt = Date.now();
  const tick = () => {
    if (!timers.has(id)) return;
    const elapsed = Date.now() - startedAt;
    const left = delay - elapsed;
    if (left <= 0) {
      timers.delete(id);
      self.postMessage({ id, firedAt: Date.now() });
      return;
    }
    const h = self.setTimeout(tick, Math.min(left, TIMER_CHUNK));
    timers.set(id, h);
  };
  const h = self.setTimeout(tick, Math.min(delay, TIMER_CHUNK));
  timers.set(id, h);
}

self.onmessage = (ev) => {
  const { type, id, delay } = ev.data || {};
  if (type === 'set') {
    const realId = id || `w${++seq}`;
    if (timers.has(realId)) self.clearTimeout(timers.get(realId));
    schedule(realId, delay);
  } else if (type === 'clear') {
    if (timers.has(id)) { self.clearTimeout(timers.get(id)); timers.delete(id); }
  } else if (type === 'ping') {
    self.postMessage({ id: 'pong', t: Date.now() });
  }
};
