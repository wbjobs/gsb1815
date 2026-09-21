import { createPermissionCache } from '../src/index.js';

const KEYS = ['doc:read', 'doc:edit', 'admin:access'];

const els = {
  rows: document.querySelector('#cacheRows'),
  badges: document.querySelector('#adapterBadges'),
  log: document.querySelector('#eventLog'),
  cfgTtl: document.querySelector('#cfgTtl'),
  cfgLatency: document.querySelector('#cfgLatency'),
  cfgFail: document.querySelector('#cfgFail'),
  cfgFailIdb: document.querySelector('#cfgFailIdb'),
  cfgForceMem: document.querySelector('#cfgForceMem'),
  cfgForceTimer: document.querySelector('#cfgForceTimer'),
  cfgNoBroadcast: document.querySelector('#cfgNoBroadcast'),
};

let cache = null;
let tickHandle = null;

/* 模拟服务端：每个 key 的权限值随版本变化，便于观察“重新校验”拿到新值 */
const serverVersion = { 'doc:read': 1, 'doc:edit': 1, 'admin:access': 1 };
setInterval(() => {
  KEYS.forEach((k) => { serverVersion[k] += 1; });
}, 20_000);

function mockFetchPermission(key) {
  const latency = Number(els.cfgLatency.value) || 0;
  const fail = els.cfgFail.checked;
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (fail) reject(new Error('模拟网络错误：权限服务 503'));
      else resolve({ allowed: key !== 'admin:access', v: serverVersion[key], t: Date.now() });
    }, latency);
  });
}

/* ---------- 日志 & Toast 异常提示 ---------- */
function log(event, detail = '', level = '') {
  const li = document.createElement('li');
  if (level) li.className = level;
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false }) +
    '.' + String(Date.now() % 1000).padStart(3, '0');
  li.innerHTML = `<span class="t">${t}</span><span class="ev">${event}</span><span class="msg"></span>`;
  li.querySelector('.msg').textContent = typeof detail === 'string' ? detail : JSON.stringify(detail);
  els.log.prepend(li);
  while (els.log.children.length > 200) els.log.lastChild.remove();
}

function toast(title, message, level = '') {
  const host = document.querySelector('#toastHost');
  const div = document.createElement('div');
  div.className = `toast ${level}`;
  div.innerHTML = `<strong></strong><span></span>`;
  div.querySelector('strong').textContent = title;
  div.querySelector('span').textContent = message;
  host.appendChild(div);
  setTimeout(() => { div.style.opacity = '0'; div.style.transition = 'opacity .3s'; setTimeout(() => div.remove(), 300); }, 4200);
}

/* ---------- 事件绑定 ---------- */
function wireEvents(c) {
  c.on('hit', ({ key, state }) => log('cache:hit', `${key} (${state})`));
  c.on('set', ({ key, entry }) => log('cache:set', `${key} → v${entry.value?.v ?? '?'}，TTL=${entry.expiresAt - entry.createdAt}ms`));
  c.on('expired', ({ key }) => log('ttl:expired', `${key} 到期，立即重新校验`, 'warn'));
  c.on('revalidate:start', ({ key, background }) => log('revalidate:start', `${key}${background ? '（后台）' : ''}`));
  c.on('revalidate:done', ({ key, value, background }) =>
    log('revalidate:done', `${key} → v${value?.v ?? '?'}${background ? '（后台）' : ''}`));
  c.on('revalidate:error', ({ key, error, background }) =>
    log('revalidate:error', `${key}: ${error?.message || error}`, 'error'));
  c.on('invalidate', ({ key, origin }) =>
    log(`invalidate:${origin}`, origin === 'remote' ? `收到广播，${key} 已失效并立即重新校验` : `${key} 已失效`, origin === 'remote' ? 'warn' : ''));
  c.on('invalidate:all', ({ origin, keys }) => log(`invalidate-all:${origin}`, keys.join(', '), 'warn'));
  c.on('fallback', ({ key, error }) => {
    log('fallback:stale', `${key} 回源失败，使用最后缓存值兜底：${error?.message || error}`, 'warn');
    toast('降级：使用旧权限值', `${key} 回源失败，已临时使用本地最后已知值。`, 'warn');
  });
  c.on('degrade', ({ layer, reason, error }) => {
    const name = { storage: '缓存存储', scheduler: 'TTL 定时器', broadcaster: '跨页广播' }[layer] || layer;
    log('degrade', `${name} 降级（${reason}${error ? '：' + error : ''}）`, 'warn');
    toast('能力降级', `${name}已切换到降级方案，功能仍可用。原因：${reason}`, 'warn');
  });
  c.on('error', ({ key, phase, background, error }) => {
    const msg = `[${phase}] ${key || ''}: ${error?.message || error}`;
    log('error', msg, 'error');
    if (background) toast('后台异常', msg + '（将在下次读取时重试）', 'error');
  });
}

/* ---------- 渲染 ---------- */
const STATE_LABEL = {
  fresh: '新鲜', stale: '过期宽限(SWR)', expired: '已过期', missing: '未缓存',
};

function render() {
  if (!cache) return;
  const snap = cache.snapshot();
  els.rows.textContent = '';
  for (const key of KEYS) {
    const s = snap[key] || { state: 'missing', entry: null, remaining: 0 };
    const tr = document.createElement('tr');
    const val = s.entry?.value;
    tr.innerHTML = `
      <td><code>${key}</code></td>
      <td><span class="state state-${s.state}">${STATE_LABEL[s.state] || s.state}</span></td>
      <td class="ttl">${s.state === 'fresh' || s.state === 'stale' ? (s.remaining / 1000).toFixed(1) + ' s' : '—'}</td>
      <td>${val ? `allowed=${val.allowed}, v${val.v}` : '—'}</td>
      <td><div class="row-actions">
        <button data-act="get">查询</button>
        <button data-act="invalidate">失效+广播</button>
        <button data-act="force">强制刷新</button>
      </div></td>`;
    tr.querySelector('[data-act="get"]').onclick = () => queryKey(key);
    tr.querySelector('[data-act="invalidate"]').onclick = () => cache.invalidate(key);
    tr.querySelector('[data-act="force"]').onclick = () => cache.get(key, { forceRefresh: true });
    els.rows.appendChild(tr);
  }
  renderBadges();
}

function renderBadges() {
  const info = cache.adapterInfo || {};
  const items = [
    ['IndexedDB', info.indexedDB],
    ['内存降级', info.memory],
    ['Worker TTL', info.worker],
    ['BroadcastChannel', info.broadcast],
  ];
  els.badges.textContent = '';
  for (const [label, on] of items) {
    const b = document.createElement('span');
    b.className = `badge ${on ? 'ok' : 'off'}`;
    b.textContent = `${label}：${on ? '启用' : '未启用'}`;
    els.badges.appendChild(b);
  }
}

async function queryKey(key) {
  try {
    const r = await cache.get(key);
    log('query:result', `${key} → ${r.state}, allowed=${r.value?.allowed}, v=${r.value?.v}`);
    if (r.state === 'fallback') { /* toast 已由 fallback 事件发出 */ }
  } catch (err) {
    log('query:error', `${key}: ${err.message}`, 'error');
    toast('权限查询失败', `${key}：${err.message}。请稍后重试。`, 'error');
  }
  render();
}

/* ---------- 构建/重建 ---------- */
async function build() {
  if (cache) { clearInterval(tickHandle); await cache.close(); }
  // “模拟 IndexedDB 故障”：在实例化前注入故障
  if (els.cfgFailIdb.checked) installIdbFailure(); else uninstallIdbFailure();

  const ttl = Math.max(100, Number(els.cfgTtl.value) || 10_000);
  cache = createPermissionCache({
    ttl,
    fetchPermission: mockFetchPermission,
    knownKeys: KEYS,
    forceMemory: els.cfgForceMem.checked,
    forceMainThreadTimer: els.cfgForceTimer.checked,
    forceNoBroadcast: els.cfgNoBroadcast.checked,
  });
  window.__cache = cache;
  wireEvents(cache);
  await cache.warm();
  log('instance:ready', `TTL=${ttl}ms, adapters=${JSON.stringify(cache.adapterInfo)}`);
  render();
  clearInterval(tickHandle);
  tickHandle = setInterval(render, 200);
}

let idbPatched = false;
function installIdbFailure() {
  if (idbPatched) return;
  idbPatched = true;
  // 让 indexedDB.open 直接抛错，模拟隐私模式/配额策略下 IndexedDB 不可用（构建即降级）。
  const origOpen = IDBFactory.prototype.open;
  IDBFactory.prototype.open = function () {
    throw new DOMException('模拟：IndexedDB 被禁用（隐私模式/配额策略）', 'SecurityError');
  };
  IDBFactory.prototype.__origOpen = origOpen;
}
function uninstallIdbFailure() {
  if (!idbPatched) return;
  idbPatched = false;
  IDBFactory.prototype.open = IDBFactory.prototype.__origOpen;
}

document.querySelector('#btnRebuild').onclick = () => build().catch((err) => {
  log('instance:error', err.message, 'error');
  toast('初始化失败', err.message, 'error');
});
document.querySelector('#btnInvalidateAll').onclick = () => cache.invalidateAll();
document.querySelector('#btnWarm').onclick = async () => { await cache.warm(); render(); };
document.querySelector('#btnClearLog').onclick = () => (els.log.textContent = '');

build().catch((err) => toast('初始化失败', err.message, 'error'));
