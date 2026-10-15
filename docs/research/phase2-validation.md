# Phase 2 验证记录

- Status: Windows implementation complete; Project allowlist migration remains in Phase 3
- Started: 2026-10-15
- Current host: Windows 10.0.26100

## 当前交付

- [x] Strategy manifest schema v1 与共享类型
- [x] 严格字段、权限、SemVer、JSON 配置、超时和源码大小校验
- [x] HTTP(S) scheme/host/subdomain/port/path match pattern
- [x] match、exclude、top/all frame scope
- [x] `enabled + Project allowlist + URL` 三重选择边界
- [x] 版本化 Strategy 注册表、串行原子更新和损坏文件隔离
- [x] 每个 Strategy 独立 world 的执行器和显式 main-world 能力
- [x] document-start/end/idle 与 top/all frame 生命周期
- [x] 配置、日志、领域事件与受 allowlist 约束的网络请求 API
- [x] 启动超时、心跳、故障归因、隔离和 renderer 重建路径
- [x] 显式开发 allowlist、保存后重建和 Strategy 编辑/启停 UI
- [x] 真实死循环故障注入与热重载端到端验收

## 2026-10-15：manifest、匹配与存储

验证命令：

```bash
npm run typecheck
npm test
git diff --check
```

结果：

- Node 与 Web TypeScript 工程均通过严格类型检查。
- 12 个测试文件、50 项测试通过。
- Strategy matcher 覆盖精确主机、子域、scheme/port wildcard、默认端口、path/query、exclude、frame scope、allowlist 和非 Web URL 安全失败。
- Strategy Store 覆盖空状态、排序、并发写入、启停、删除、未知字段/权限、重复 pattern、非法 JSON 配置和损坏文件隔离。
- 差异检查无空白错误。

## 2026-10-15：隔离执行与宿主 API

验证命令：

```bash
npm run typecheck
npm test
npm run smoke:electron
```

结果：

- 14 个测试文件、62 项测试通过；新增覆盖生命周期令牌、frame 身份、独立 world 分配、权限拒绝、网络 allowlist、run-at 等待、启动超时、心跳故障、main-world 审计和显式开发 allowlist。
- 每个匹配 Strategy 获得独立 Chromium isolated world；页面和 Strategy 都无法看到对方的私有全局，DOM 变更仍按预期共享。
- `document-start` 在页面首个 inline script 前完成监听器安装，覆盖 top frame、同源 iframe 和跨域 OOPIF；`document-idle` 的配置、日志、领域事件、受控网络请求与显式 main-world 执行均通过真实 Electron 链路。
- renderer 被强制终止并重建后，4 个匹配执行实例全部恢复为 `running`，没有丢失 frame scope 或 allowlist。
- session frame preload 必须是单文件 CommonJS。首次验证捕获到 Vite 共享 chunk 在沙箱/OOPIF 中无法加载；移除运行时共享 import 后，构建产物为独立 `strategy-bootstrap.cjs`，preload error 清零。
- session preload 只在受控 Profile session 中注册；性能探针的辅助 WebContents 使用独立临时 session，不会误触发 Strategy bootstrap。
- BrowserShell 已提供 Manifest JSON/源码编辑、启停、显式 allowlist、删除和“保存并重载页面”；所有调用只接受受信 Shell sender。

## 2026-10-15：热重载与死循环故障注入

验证命令：

```bash
npm run smoke:electron
npm run smoke:strategy-fault
npm run smoke:strategy-workspace
npm run smoke:recovery
```

结果：

- 保存配置使用受控 view 重建完成热重载，页面代次递增；更新后的 `0.1.1` Strategy 在 top frame、同源 iframe 和跨域 OOPIF 中全部运行，随后再次强杀 renderer 后仍恢复。
- `smoke-document-start` 在页面首个 inline script 前写入 DOM，三个 frame 均观测到 `readyState=loading`；Strategy 私有全局未泄漏到页面，Node `process/require` 不可见。
- `smoke-idle-host-api` 完成配置读取、受限网络请求、领域事件和显式 main-world 执行；网络响应 marker 与页面 world marker 均通过。
- 故障 Strategy 就绪后主动同步死循环。宿主在心跳超过 1,000 ms 后归因到 `smoke-heartbeat-block`，记录 `strategy-heartbeat-missed` 与 `strategy-quarantined`，强制终止 renderer，并在约 2.9 秒内重建到健康页面。
- 重建后的 Strategy 活跃数为 0，隔离列表保留故障 ID，恢复状态为 `idle`、页面 `responsive: true`，证明故障脚本没有形成重启循环。
- 工作台真实 IPC 链路依次完成保存、显式授权、`0.1.0 → 0.1.1` 源码更新、停用、重启用和删除；页面代次每步递增，运行实例与 DOM marker 均随配置变化，删除后定义和临时 allowlist 同时清空。
- Phase 1 的权限、弹窗、Profile、多 tab、下载、四级恢复与熔断 smoke 在同一改动后继续通过。

## 安全与能力边界

- `<all_urls>` 仅表示 HTTP/HTTPS，不包含 `file:`、`data:`、`javascript:` 或其他协议。
- Project 尚未实现；当前 matcher 接收调用方传入的显式 allowlist，执行器不得自行绕过。
- manifest 的 DOM 权限目前是声明与审计信息。任意页面脚本一旦执行便无法靠该声明可靠细分 DOM 读写；网络、文件、领域事件等宿主能力必须在可信边界强制校验。
- `main-world` 是高风险显式宿主权限：启用后允许 Strategy 通过受审计桥在页面 world 执行源码，但该 world 仍没有 Node、宿主文件或原始 IPC。拥有 DOM 写能力的任意脚本本就可能插入页面 `<script>`，因此该声明不能被描述成对所有页面 world 影响的绝对隔离。
- 特权宿主网络请求只允许 HTTP(S)，每次初始 URL及重定向都必须命中 Strategy 自己的 `networkMatches`；敏感请求头、超大请求/响应和过多重定向会被拒绝。Strategy 仍可调用页面原生 `fetch`/XHR，并受页面 Origin、CORS、CSP 与 Cookie 规则约束；`network.request` 只控制宿主增强能力。
- Strategy 没有任何文件或 shell API。死循环会占住其所属 renderer 主线程，Chromium 无法只终止那个 isolated world；监督器的处理方式是归因并隔离 Strategy、终止 renderer、再重建页面。
- IPv6 host pattern 当前不支持；若真实目标站点需要，必须先补解析与回归测试。
- 当前 `developmentAllowedStrategyIds` 是 Phase 2 临时显式边界；Phase 3 必须迁入真正的 Project allowlist 和固定版本快照。
