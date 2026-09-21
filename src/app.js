import { PermissionCache } from './permission-cache.js';
import { MockPermissionApi } from './mock-api.js';

const CACHE_KEY = 'permission:demo';
const TTL_SECONDS = 8;

const api = new MockPermissionApi({ delay: 350 });
const cache = new PermissionCache({
  fetcher: (key, context) => api.fetchPermissions(key, context),
  defaultTtl: TTL_SECONDS * 1000,
  workerFactory: sessionStorage.getItem('permission-demo:disable-worker')
    ? () => { throw new Error('模拟 Worker 创建失败'); }
    : undefined,
  fallbackValue: {
    allowed: false,
    permissions: [],
    degraded: true,
    message: '权限接口不可用，已使用最小可用权限'
  }
});

const elements = {
  mode: document.querySelector('#mode'),
  status: document.querySelector('#status'),
  source: document.querySelector('#source'),
  ttl: document.querySelector('#ttl'),
  version: document.querySelector('#version'),
  permissions: document.querySelector('#permissions'),
  refresh: document.querySelector('#refresh'),
  invalidate: document.querySelector('#invalidate'),
  grant: document.querySelector('#grant'),
  revoke: document.querySelector('#revoke'),
  fail: document.querySelector('#fail'),
  workerFail: document.querySelector('#worker-fail'),
  reset: document.querySelector('#reset'),
  logs: document.querySelector('#logs'),
  toast: document.querySelector('#toast')
};

let lastResult = null;
let toastTimer = null;

cache.addEventListener('state', (event) => {
  const { reason, mode, records } = event.detail;
  renderState(records, mode);
  const record = records.get(CACHE_KEY);
  if (record) {
    renderResult({
      status: record.stale ? 'stale' : 'fresh',
      source: record.stale ? 'stale-cache' : (reason === 'ready' ? 'cache' : 'remote'),
      value: record.value,
      record
    });
  }
  writeLog('state', `${labelForReason(reason)}`, event.detail);

  if (reason === 'ready') {
    showToast(mode === 'fallback' ? 'Worker 不可用，已进入降级模式' : `缓存通道就绪：${mode}`, mode === 'fallback' ? 'warn' : 'info');
  }
  if (reason === 'broadcast') {
    showToast('收到其他页面的失效广播，正在立即重新校验', 'info');
  }
  if (reason === 'invalidate') {
    showToast('权限已失效，正在立即重新校验', 'warn');
  }
  if (reason === 'ttl') {
    showToast('TTL 到期，正在后台重新校验', 'info');
  }
});

cache.addEventListener('error', (event) => {
  const { scope, error, mode } = event.detail;
  writeLog('error', `${scope}: ${error.message}`, event.detail);
  if (scope === 'worker-start' || scope === 'worker-runtime') {
    showToast('Worker 异常，已自动降级到主线程缓存', 'warn');
  } else if (scope === 'fetch') {
    showToast(`权限接口异常：${error.message}，继续使用可用降级权限`, 'error');
  } else {
    showToast(`${scope} 异常：${error.message}（当前模式：${mode}）`, 'warn');
  }
});

elements.refresh.addEventListener('click', async () => {
  setBusy(true);
  try {
    lastResult = await cache.refresh(CACHE_KEY, { reason: 'manual', force: true });
    renderResult(lastResult);
    showToast('权限重新校验完成', 'success');
  } finally {
    setBusy(false);
  }
});

elements.invalidate.addEventListener('click', async () => {
  setBusy(true);
  try {
    const result = await cache.invalidate(CACHE_KEY, 'manual');
    showToast(`失效完成并已重新校验：${result.matchedKeys?.length ?? 0} 条`, 'success');
  } finally {
    setBusy(false);
  }
});

elements.grant.addEventListener('click', () => {
  api.grant('document:publish');
  writeLog('api', '后端权限已增加 document:publish，等待失效后同步');
  showToast('已在模拟后端增加权限，点击“失效并广播”验证', 'info');
});

elements.revoke.addEventListener('click', () => {
  api.revoke('document:comment');
  writeLog('api', '后端权限已移除 document:comment，等待失效后同步');
  showToast('已在模拟后端移除权限，点击“失效并广播”验证', 'info');
});

elements.fail.addEventListener('click', () => {
  api.failOnce();
  showToast('下一次权限接口请求将失败，用于验证异常提示和降级值', 'warn');
});

elements.workerFail.addEventListener('click', () => {
  sessionStorage.setItem('permission-demo:disable-worker', '1');
  showToast('将刷新页面并进入 Worker 降级模式', 'warn');
  setTimeout(() => location.reload(), 600);
});

elements.reset.addEventListener('click', async () => {
  api.reset();
  sessionStorage.removeItem('permission-demo:disable-worker');
  await new Promise((resolve) => {
    const request = indexedDB.deleteDatabase('permission-cache');
    request.onsuccess = resolve;
    request.onerror = resolve;
    request.onblocked = resolve;
  });
  location.reload();
});

async function bootstrap() {
  setBusy(true);
  await cache.init();
  lastResult = await cache.get(CACHE_KEY);
  renderResult(lastResult);
  setBusy(false);
  setInterval(() => renderState(cache.getSnapshot(), cache.mode), 100);
}

function renderResult(result) {
  elements.status.textContent = result?.error ? '接口异常，使用降级/旧值' : statusLabel(result?.status ?? result?.source);
  elements.source.textContent = result?.source ?? '-';
  elements.version.textContent = String(result?.value?.version ?? '-');
  elements.permissions.textContent = (result?.value?.permissions ?? []).join('、') || '无权限';
  renderState(cache.getSnapshot(), cache.mode);
}

function renderState(records, mode) {
  elements.mode.textContent = modeLabel(mode);
  const record = records.get(CACHE_KEY);
  if (!record) {
    elements.ttl.textContent = '未缓存';
    return;
  }
  if (record.stale || record.expiresAt === 0) {
    elements.ttl.textContent = record.stale ? '已失效/重新校验中' : '不过期';
  } else {
    const remaining = Math.max(0, record.expiresAt - Date.now());
    elements.ttl.textContent = `${Math.ceil(remaining / 1000)} 秒`;
  }
  if (record.value && (!lastResult || lastResult.source !== 'remote')) {
    lastResult = {
      status: record.stale ? 'stale' : 'fresh',
      source: record.stale ? 'stale-cache' : 'cache',
      value: record.value
    };
  }
}

function setBusy(busy) {
  document.querySelectorAll('button').forEach((button) => {
    button.disabled = busy;
  });
}

function writeLog(level, message, detail) {
  const item = document.createElement('li');
  item.className = `log-item log-${level}`;
  const time = new Date().toLocaleTimeString();
  item.textContent = `${time} · ${message}`;
  if (detail?.matchedKeys) {
    item.textContent += ` · keys=${detail.matchedKeys.join(',')}`;
  }
  elements.logs.prepend(item);
  while (elements.logs.children.length > 30) {
    elements.logs.lastElementChild.remove();
  }
}

function showToast(message, tone = 'info') {
  elements.toast.textContent = message;
  elements.toast.className = `toast toast-${tone} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    elements.toast.classList.remove('show');
  }, 3200);
}

function labelForReason(reason) {
  return {
    ready: '缓存通道就绪',
    refresh: '后台刷新完成',
    manual: '手动重新校验完成',
    invalidate: '缓存已失效',
    broadcast: '收到跨页面广播',
    ttl: 'TTL 到期',
    set: '缓存被更新'
  }[reason] ?? reason;
}

function modeLabel(mode) {
  return {
    initializing: '初始化中',
    worker: 'Worker + IndexedDB + BroadcastChannel',
    'worker-no-broadcast': 'Worker 模式（广播不可用）',
    fallback: '主线程降级模式'
  }[mode] ?? mode;
}

function statusLabel(status) {
  return {
    fresh: '新鲜缓存',
    stale: '旧缓存，后台刷新中',
    miss: '缓存未命中',
    remote: '接口最新值',
    cache: '缓存命中',
    'stale-cache': '旧缓存降级',
    fallback: '默认降级权限'
  }[status] ?? status;
}

bootstrap().catch((error) => {
  showToast(`初始化失败：${error.message}`, 'error');
});
