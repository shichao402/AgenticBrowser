# ADR-0005: Strategy 使用独立 world 与宿主能力门

- Status: Accepted
- Date: 2026-10-15

## Context

Strategy 需要像 userscript 一样读写页面 DOM，同时不能获得 Node、原始 IPC、文件、shell 或未经授权的网络能力。它还可能抛错、永久等待或同步占满 renderer 主线程。仅把源码包装进 preload 函数会让脚本接触 preload 的特权全局；在页面 main world 执行则会和网站脚本共享全局，无法形成默认隔离。

Chromium isolated world 可以隔离 JavaScript 全局但仍共享 DOM。不过 Chromium 没有安全 API 可单独抢占一个已经同步死循环的 DOM world，因此“每脚本 world”不等于“每脚本进程”。

## Decision

- session frame preload 在每个 HTTP(S) frame 启动，主进程依据真实 `senderFrame` URL、frame scope、启停状态和显式 allowlist 选择 Strategy。
- 每个 Strategy 在每个匹配 frame 使用独立 isolated world；页面 main world 和其他 Strategy 看不到其私有全局。
- preload 只暴露窄宿主桥。配置、日志、领域事件、网络请求和 main-world 执行均绑定随机执行令牌，并在主进程重新校验 frame、状态与 manifest 权限。
- 默认不通过宿主桥执行 main-world 源码；只有声明 `main-world` 后桥才允许，且页面 world 仍无 Node 或原始 IPC。此权限是宿主 API 边界，不声称能阻止拥有 DOM 写能力的脚本自行插入页面 `<script>`。
- 特权宿主网络请求逐跳校验 `networkMatches`，拒绝敏感请求头、超限请求/响应和重定向逃逸。Strategy 仍可使用页面自身的 `fetch`/XHR，并受页面 Origin、CORS、CSP 和浏览器 Cookie 规则约束。
- 保存、启停或 allowlist 变化通过重建受控 `WebContentsView` 完成热重载，从进程边界清除旧监听器和 timer，不假装能够卸载任意页面脚本。
- 主进程维护启动与心跳期限。Strategy 阻塞 renderer 时，将该 ID 隔离、强制终止 renderer，再由 RecoveryEngine 重建页面；新页面不再注入被隔离 Strategy。

## Consequences

正面影响：

- Strategy 默认无法接触 preload 特权、Node、文件、shell 或任意 IPC。
- top frame、同源 iframe 和跨域 OOPIF 使用同一匹配与权限模型。
- 宿主可以可靠记录运行、日志、超时、隔离和恢复事件。
- 同步死循环最终能从 Electron 主进程外部终止，不依赖被阻塞页面自救。

代价：

- DOM 本身无法按 `dom.read/write/click` 声明做强制细粒度隔离，这些权限只能用于声明和审计。
- `network.request` 与 `main-world` 只约束 AgenticBrowser 提供的增强宿主桥，不能冒充对全部页面 Web API 的沙箱。
- 一个 renderer 进程可能承载多个 frame；强制终止会影响同进程内容，因此必须依赖页面重建和业务幂等恢复。
- 热重载会刷新页面，而不是保留任意未声明的页面内瞬时状态。
- Phase 2 临时开发 allowlist 必须在 Phase 3 被 Project 固定版本 allowlist 取代。

## Rejected alternatives

- 直接在页面 main world 执行所有 Strategy：全局污染和网站脚本干扰不可接受。
- 在 preload 自身通过 `Function` 执行源码：会扩大脚本接触 preload 特权全局的风险。
- 所有 Strategy 共用一个 isolated world：脚本间全局状态和故障无法隔离。
- 声称可只终止单个死循环 world：Chromium 当前不提供这种可靠抢占边界。
