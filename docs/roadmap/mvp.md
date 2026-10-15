# MVP 路线图

- Status: Phase 1 in progress; Phase 0 macOS/real-site gates pending
- Scope: Phase 0–3

MVP 的完成标准不是“能打开网页”，而是知识星球项目可以在故障注入下可靠扫描、筛选和下载，并能被监控。

## Phase 0：Electron Spike

当前切片：工程基线、BrowserShell/远程页面隔离、frame/OOPIF 注入、renderer 重建、主动页面心跳、应用外 Watchdog 强杀恢复、最小 URL/Profile 检查点、有硬上限的单/双页面 10 FPS 截图环、交互影响和 Windows 安装后启动已经通过验证。仍需完成真实目标站点与 macOS 验证。证据持续记录在 [Phase 0 验证记录](../research/phase0-validation.md)。

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

当前切片：多 tab、主动 HealthMonitor、分级 RecoveryPolicy、恢复预算与熔断、本地错误页、Capability Center、弹窗路由、基础 Download Manager、JSONL 事件日志和进程/页面/下载监控已经落地。Profile 管理 UI、按站点权限、完整下载事务和安装包 Watchdog launcher 尚未完成。证据见 [Phase 1 验证记录](../research/phase1-validation.md)。

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

### 交付

- Project/Profile/Runtime 数据模型和迁移版本。
- 常驻、定时、自动启动和手动模式。
- 全局并发、资源预算和项目单实例锁。
- Workflow 状态机、断言、检查点、幂等和熔断。
- Download Manager、项目目录和元数据。
- 内置 Content Filter。
- 项目监控和人工接管。
- 知识星球 Feed、分类和 MP3 下载策略。

### 通过条件

- 知识星球流程满足 [试点验收](knowledge-planet-pilot.md)。
- 常驻与定时项目可并发，Profile 和目录不串扰。
- 重启、补跑不会重复下载。
- 断网、页面变化、renderer 崩溃和磁盘不足均能分类处理。

## MVP 之后

- Phase 4：示教录制与候选 workflow。
- Phase 5：CodeBuddy Agent SDK 和受限浏览器工具。
- 通用插件 API 只有在 Project/Strategy/权限模型稳定后才评估。
