import {
  IdbStorage, MemoryStorage, WorkerScheduler, TimerScheduler, ChannelBroadcaster,
} from './adapters.js';

/*
 * 浏览器适配器装配：能力探测 + 构建失败/运行失败逐级降级。
 * force* 选项供 Demo 手动模拟降级场景。
 */
export function createBrowserAdapters(options = {}) {
  const report = options.report || (() => {});
  const info = { indexedDB: false, worker: false, broadcast: false, memory: false };

  // ---- 存储 ----
  let storage;
  if (options.forceMemory || !IdbStorage.isSupported()) {
    storage = new MemoryStorage();
    info.memory = true;
    if (!options.forceMemory) report('storage', { reason: 'unsupported' });
    else report('storage', { reason: 'forced' });
  } else {
    try {
      storage = new IdbStorage({ dbName: options.dbName });
      info.indexedDB = true;
    } catch (err) {
      storage = new MemoryStorage();
      info.memory = true;
      report('storage', { reason: 'construct-error', error: String(err?.message || err) });
    }
  }

  // ---- 定时器（TTL） ----
  let scheduler;
  const workerUrl = options.workerUrl || new URL('./worker.js', import.meta.url);
  if (options.forceMainThreadTimer || !WorkerScheduler.isSupported()) {
    scheduler = new TimerScheduler();
    if (!options.forceMainThreadTimer) report('scheduler', { reason: 'unsupported' });
    else report('scheduler', { reason: 'forced' });
  } else {
    try {
      scheduler = new WorkerScheduler(workerUrl);
      info.worker = true;
    } catch (err) {
      scheduler = new TimerScheduler();
      report('scheduler', { reason: 'construct-error', error: String(err?.message || err) });
    }
  }

  // ---- 广播 ----
  let broadcaster = null;
  if (options.forceNoBroadcast || !ChannelBroadcaster.isSupported()) {
    if (!options.forceNoBroadcast) report('broadcaster', { reason: 'unsupported' });
    else report('broadcaster', { reason: 'forced' });
  } else {
    try {
      broadcaster = new ChannelBroadcaster(options.broadcastKey || 'permission-cache');
      info.broadcast = true;
    } catch (err) {
      report('broadcaster', { reason: 'construct-error', error: String(err?.message || err) });
    }
  }

  return { storage, scheduler, broadcaster, info };
}
