# 权限缓存、TTL、失效广播与降级

这是一个无构建依赖的原生浏览器示例，使用：

- `IndexedDB`：Worker 内持久化权限缓存。
- `Web Worker`：维护 TTL、缓存状态和跨页消息。
- `BroadcastChannel`：一个标签页失效后，立即通知其他标签页重新校验。
- 主线程降级：Worker、IndexedDB、BroadcastChannel 或接口异常时仍返回旧缓存或最小可用权限。

## 启动

```bash
npm start
```

然后打开：

```text
http://127.0.0.1:5173/index.html
```

不要直接用 `file://` 打开，因为模块 Worker 需要 HTTP 源。

## 验收方式

- 缓存：首次加载自动回源，随后读取 IndexedDB 缓存。
- TTL：TTL 为 8 秒；每个缓存键使用独立到期定时器，到期后返回旧值并后台重新校验。
- 失效：点击“失效并广播”，缓存立即标记 stale，并强制发起新权限请求。
- 广播：复制两个标签页，任一标签页失效后，另一个标签页立即收到广播、标记失效并重新校验。
- 降级：点击“进入 Worker 降级模式”，刷新后自动切到主线程缓存，广播仍可用。
- 异常：点击“模拟下一次接口异常”，页面显示 Toast 和错误日志；有旧值用旧值，无旧值用默认最小权限。

## 代码结构

- `index.html`：验收演示页面。
- `src/permission-cache.js`：主线程 API，负责 Worker 生命周期、网络刷新和异常降级。
- `src/permission-worker.js`：Worker 缓存状态机，处理 TTL、IndexedDB、广播和等待中的重新校验。
- `src/idb-store.js`：IndexedDB 读写封装与通配符匹配。
- `src/fallback-cache.js`：Worker 不可用时的主线程缓存和广播实现。
- `src/mock-api.js`：模拟权限接口、权限变更和接口失败。
- `test/`：Node 内置测试，覆盖 TTL、失效、广播、异常和 Worker 降级。

运行测试：

```bash
npm test
```
