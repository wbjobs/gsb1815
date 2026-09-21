import { PermissionCache } from './core.js';
import { createBrowserAdapters } from './browser-adapters.js';

export * from './core.js';
export * from './adapters.js';
export { createBrowserAdapters } from './browser-adapters.js';

/** 浏览器环境一键创建；能力探测阶段的降级也通过 'degrade' 事件上报 */
export function createPermissionCache(options = {}) {
  let coreRef = null;
  const adapters = createBrowserAdapters({
    ...options,
    report: (layer, info) => coreRef?.emit('degrade', { layer, ...info }),
  });
  const core = new PermissionCache(adapters, options);
  coreRef = core;
  core.adapterInfo = adapters.info;
  return core;
}
