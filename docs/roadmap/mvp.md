# MVP 路线图

- Status: Phase 0–3 core and two public real-site gates implemented; failure-matrix and macOS gates pending
- Scope: Phase 0–3

MVP 的完成标准不是“能打开网页”，而是公开真实站点上的多页面项目可以在故障注入下可靠操作、下载、恢复并被监控。

## Phase 0：Electron Spike

当前切片：工程基线、BrowserShell/远程页面隔离、frame/OOPIF 注入、renderer 重建、主动页面心跳、应用外 Watchdog 强杀恢复、最小 URL/Profile 检查点、有硬上限的单/双页面 10 FPS 截图环、交互影响、Windows 安装后启动，以及 Selenium 与 Test Pages 两个公开真实站点已经通过验证。仍需完成 macOS 验证。证据持续记录在 [Phase 0 验证记录](../research/phase0-validation.md)。

### 交付

- 最小 Electron 壳和一个 `WebContentsView`。
- sandbox/context isolation 验证。
- URL 导航和 `document_start` 注入探针。
- 跨域 iframe/OOPIF 观测。
- 加载失败、无响应、renderer 崩溃和 view 重建演示。
- 独立 Watchdog 强杀恢复演示。
- `capturePage` 10 FPS 环形缓冲性能报告。
- Windows/macOS 最小安装包。

### 通过条件

- 两个目标站点的核心路径功能可用。
- renderer 崩溃后能重建页面且 session 不丢失。
- main process 被杀后能恢复到持久化检查点。
- 10 FPS 录制在目标硬件上不破坏页面操作。
- 发现的兼容差异已记录到 `docs/research/`。

## Phase 1：BrowserShell 与监督

当前切片：多 tab、基础 Profile 管理与 session 隔离、主动 HealthMonitor、分级 RecoveryPolicy、恢复预算与熔断、本地错误页、默认策略 + 精确 Origin 的 Capability Center、弹窗路由、基础 Download Manager、JSONL 事件日志、进程/页面/下载监控，以及打包应用 Watchdog launcher 和登录启动 API/UI 已经落地。Windows 已验证 Watchdog、重复启动锁和 packaged 登录项能力读取；实际修改登录项及重启自启 E2E 尚未执行。Profile 的 Project 引用保护与完整下载事务随 Phase 3 Project Runtime 落地；macOS launcher/login item 仍需外部环境验证。证据见 [Phase 1 验证记录](../research/phase1-validation.md)。

### 交付

- 标签、地址栏、错误页和 BrowserShell 布局。
- Named Profile/session。
- 权限、弹窗、下载和 Capability Center。
- BrowserSupervisor、HealthMonitor 和 RecoveryEngine 基础。
- Watchdog、结构化事件日志和全局监控。
- 故障注入工具。

### 通过条件

- 远程页面无法访问 Node、原始 IPC 和宿主文件。
- 加载失败、无响应和崩溃均有明确状态与恢复动作。
- 恢复动作有预算，不会无限刷新。
- 监控展示真实 runtime/page/process 指标。

## Phase 2：Strategy MVP

Windows 实现与故障门禁已完成：manifest/存储/匹配、每 Strategy 独立 world、document-start/end/idle、top frame/OOPIF、配置/日志/领域事件/受控网络请求、显式 main-world 能力、心跳/超时/隔离、renderer 重建恢复，以及 Strategy 编辑/启停/临时显式 allowlist UI 已落地。保存或授权变化通过重建受控 view 清理旧实例并重新匹配；真实热重载和同步死循环终止探针均通过。Phase 3 已将运行态 allowlist 迁入 Project 固定版本快照，开发态临时 allowlist 仅用于独立调试。证据见 [Phase 2 验证记录](../research/phase2-validation.md)。

### 交付

- Strategy manifest 与版本。
- URL match/exclude 和 run-at。
- top frame/OOPIF 范围控制。
- 隔离 world、受控 main-world bridge。
- 最小 GM API：配置、日志、领域事件和安全网络请求。
- 权限、超时、心跳、错误和热重载。
- Strategy 编辑与启停 UI。

### 通过条件

- 未在 Project allowlist 的 Strategy 不运行。
- renderer 重建后正确恢复匹配 Strategy。
- Strategy 不能读写项目目录外文件。
- 死循环或超时 Strategy 可以被终止并报告。

## Phase 3：Project Runtime 与试点

当前切片：Project/Profile/Runtime schema v1、固定版本 Strategy、持久化 workflow/checkpoint/幂等、项目级 Capability 与 Content Filter、下载意图与原子文件事务、手动/自启/常驻/定时调度、双浏览器执行槽、人工接管和 Project 工作台已经落地。Selenium 与 Test Pages 两个真实测试站点上的表单、延迟 DOM、跨域 workflow、固定文件下载/去重、renderer 崩溃恢复，以及页面变化自动暂停与恢复已经通过；下载进行中强杀 Electron main 后，Watchdog 重启、Runtime 续跑和同业务附件安全重试也已通过。单独只杀下载页面 renderer、断网和磁盘不足门禁仍待完成。证据见 [Phase 3 验证记录](../research/phase3-validation.md)。

### 交付

- Project/Profile/Runtime 数据模型和迁移版本。
- 常驻、定时、自动启动和手动模式。
- 全局并发、资源预算和项目单实例锁。
- Workflow 状态机、断言、检查点、幂等和熔断。
- Download Manager、项目目录和元数据。
- 内置 Content Filter。
- 项目监控和人工接管。
- 无需账号的双站点表单、动态 DOM、跨域同步和下载验收 Strategy。

### 通过条件

- 双站点流程满足 [公开站点试点验收](automation-playground-pilot.md)。
- 常驻与定时项目可在双宿主中并行，共享 Profile 保持互斥且输出目录不串扰。
- 重启、补跑不会重复下载。
- 断网、页面变化、renderer 崩溃和磁盘不足均能分类处理。

## MVP 之后

- Phase 4：示教录制与候选 workflow。
- Phase 5：CodeBuddy Agent SDK 和受限浏览器工具。
- 通用插件 API 只有在 Project/Strategy/权限模型稳定后才评估。
