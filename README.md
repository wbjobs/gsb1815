# 权限缓存（IndexedDB + BroadcastChannel + Web Worker）

支持**缓存、精确 TTL、失效广播、降级、异常提示**的权限缓存模块，纯原生 ES Module，零依赖、零构建。

## 运行

```bash
# 演示页面（必须经 HTTP 访问，Web Worker / ES Module 才可用）
python3 -m http.server 8080
# 打开 http://localhost:8080/demo/ ，再点右上角“打开第二个标签页”验证跨页广播

# 单元测试
npm test          # 或 node --test tests/*.test.js
```

## 架构

```
src/
├── core.js              PermissionCache 核心：缓存 / TTL / 失效 / 广播 / 降级 / 事件
├── adapters.js          三种能力的适配器 + 降级实现
│   ├── IdbStorage       IndexedDB 持久化  → 运行期失败自动降级 MemoryStorage
│   ├── WorkerScheduler  Web Worker 精确计时 → 降级 TimerScheduler（链式 setTimeout）
│   └── ChannelBroadcaster BroadcastChannel 跨页广播 → 降级为 null（不阻断主流程）
├── worker.js            TTL 计时 Worker（独立线程 + 分片，规避 32bit 上限与页面节流）
├── browser-adapters.js  能力探测与装配（不支持 / 构建失败 / 运行失败三级降级）
├── emitter.js           轻量事件总线
└── index.js             浏览器入口 createPermissionCache()
demo/                    可视化演示（状态表、TTL 倒计时、降级开关、事件日志、Toast）
tests/                   Node test runner 单元测试（注入 Fake 适配器，确定性虚拟时钟）
```

### 缓存与 TTL
- 条目结构：`{ key, value, createdAt, expiresAt, staleExtra }`，TTL 用**绝对时间戳**判定，不依赖 setTimeout 精度。
- `get(key)`：
  - `fresh`（now < expiresAt）→ 直接返回缓存；
  - `stale`（expiresAt ≤ now < expiresAt+staleExtra）→ **立即返回旧值**，后台 SWR 重新校验；
  - `expired/missing` → 回源；回源失败时用最后已知值 `fallback` 兜底，无缓存则抛 `PermissionCacheError`。
- TTL 到期由 Worker 定时器触发**立即后台重新校验**；长延时在 Worker 内分片（每片 ≤ 2^31-1ms）。
- 相同 key 的并发回源自动去重。

### 失效与广播
- `invalidate(key)`：本地立即删除（内存 + IndexedDB + 定时器）→ **立即重新校验** → 通过 BroadcastChannel 广播。
- `invalidateAll()`：全部失效 + 广播 key 列表，各标签页按并集处理。
- 其他标签页收到消息后**立即删除并立即重新校验**（事件 `invalidate:remote`）。
- 广播失败只发 `degrade` 事件，不影响本地失效。

### 降级矩阵

| 能力 | 首选 | 降级触发 | 降级方案 |
|---|---|---|---|
| 持久化 | IndexedDB | 不支持 / open 失败 / 事务错误 / 运行期抛错 | 内存 Map（`degrade:storage`） |
| TTL 计时 | Web Worker | 不支持 / Worker 构造失败 / postMessage 失败 | 主线程链式 setTimeout（`degrade:scheduler`） |
| 跨页广播 | BroadcastChannel | 不支持 / 构造失败 / post 失败 | 仅本地生效（`degrade:broadcaster`） |
| 数据回源 | 业务 `fetchPermission` | reject / 抛错 | 最后缓存值 fallback；无值则抛错 |

### 异常提示
所有异常都通过事件暴露，UI 不出现未捕获错误：
- `error`（含 `key/phase/background/error`）：回源失败、后台重校验失败、远程消息处理失败；
- `degrade`：任一层能力降级；
- `fallback`：回源失败但旧值可用；
- Demo 中后台错误/降级以右下角 Toast 提示，全部事件同时写入“事件日志”。

## 验收标准对照

| 验收项 | 验证方式 |
|---|---|
| 失效后立即重新校验 | 演示页点“失效+广播”，日志立即出现 `invalidate:local → revalidate:start/done`；单测 `invalidate 后立即删除缓存并立即重新校验` |
| TTL 准确 | 状态表 TTL 倒计时到 0 的同一刻出现 `ttl:expired` 并重新校验；单测用虚拟时钟验证 9999ms 不触发、10000ms 整触发（`TTL 到期立即后台重新校验且时间精确`） |
| 广播及时 | 开两个标签页，A 点失效，B 毫秒级收到 `invalidate:remote` 并重校验；单测 `广播及时：A 失效，B 立即收到并重新校验` |
| 降级可用 | 勾选“强制回源失败”后查询：旧值 `fallback` 继续可用；勾选存储/定时器/广播降级开关后重建实例，功能正常且有 Toast；单测覆盖存储运行期故障降级 |
| 异常有提示 | 无缓存 + 回源失败：查询 Promise reject 且弹 Toast；后台失败：Toast + 日志；单测验证 `error` 事件 phase/background |

## 核心 API

```js
const cache = createPermissionCache({
  ttl: 10_000,                 // 数字或 (key) => number
  staleExtra: 10_000,          // SWR 宽限，默认等于 ttl
  fetchPermission: async (key) => ({ allowed: true }),
  knownKeys: ['doc:read'],     // invalidateAll / warm 的 key 集合
  // forceMemory / forceMainThreadTimer / forceNoBroadcast：手动模拟降级
});

await cache.get(key, { forceRefresh: false }); // { value, state, fromCache, error? }
await cache.invalidate(key);     // 立即失效 + 重校验 + 广播
await cache.invalidateAll();
await cache.revalidate(key);
cache.peek(key); cache.snapshot(); await cache.warm();
cache.on('error' | 'degrade' | 'fallback' | 'invalidate' | 'expired' | ..., fn);
```
