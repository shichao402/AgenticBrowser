# AgenticBrowser 产品总计划

- Last updated: 2026-10-15
- Status: Phase 3 in progress; Phase 0 macOS/real-site gates pending

## 愿景

构建一个 Windows/macOS 独立客户端，将 Chromium 页面真正嵌入产品，并提供：

- 类似 Tampermonkey 的 URL 匹配策略。
- 以项目为单位的跨页面 workflow、Profile、配置和输出。
- 页面加载失败、无响应、renderer 崩溃和应用重启后的自动恢复。
- 多项目常驻监听、定时唤醒和资源调度。
- 人工示教录制、关键帧和上下文证据。
- 受限 Agent 工具，用于未知页面、流程生成和故障诊断。
- 全局与项目级监控。

## 已确认的产品决策

- Electron + TypeScript + React + `WebContentsView`。
- 自有 BrowserShell，目标网页嵌入同一窗口。
- 功能兼容优先，不伪装成官方 Google Chrome。
- 不依赖浏览器扩展；正式扩展能力由 Strategy/GM API 提供。
- Project 负责跨页面编排，Strategy 负责匹配页面内的局部行为。
- Profile 默认项目隔离，也可显式共享。
- Project 可选择常驻监听或定时唤醒，并受全局并发预算约束。
- 确定性 workflow 与恢复优先，Agent 是升级路径。
- MVP 不包含 Widevine DRM、Chrome Sync、Google 浏览器私有 API或完整 Chrome 扩展生态。
- Adblock 类能力先实现为内置 Content Filter，不先建设通用插件平台。

## 产品界面

### 工作台

- 左侧固定侧栏：项目、策略、过滤器。
- 右侧大区域：当前项目的内嵌浏览器和 tabs。
- 底部运行抽屉：workflow、策略、日志、下载、Agent 与恢复动作。
- 独立监控页：全局指标和项目下钻。

### 监控

显示：

- 活跃、排队和失败的 Project Runtime。
- tab/`WebContentsView` 与 renderer/GPU/utility 进程。
- 正在运行、等待和失败的 Strategy。
- Supervisor、Project、Page、Strategy 四级心跳。
- CPU、内存、磁盘、队列和下载。
- workflow 当前步骤、失败次数、恢复级别和故障时间线。

## 核心能力

### 内嵌浏览器

- 自有地址栏、标签、错误页、权限和下载体验。
- 独立持久化 session partition。
- 页面 sandbox、context isolation、禁用 Node integration。
- 页面、session 和子进程生命周期观测。

### Strategy

- URL `matches/excludes`。
- `runAt` 和 frame 范围。
- 版本、配置 schema 和权限。
- 隔离 world 与受控 main-world bridge。
- 心跳、完成信号、日志、超时和回滚。

### Project Runtime

- Strategy allowlist 与固定版本。
- 启动页面和显式状态机。
- Profile、能力开关、secrets 引用和输出目录。
- 手动、自动启动、常驻、定时四类模式。
- 并发、单实例、超时、重试、熔断和补跑。
- 持久化检查点与幂等记录。

### 故障恢复

1. 健康探针失败后短暂等待和退避。
2. 停止加载并普通 reload。
3. 忽略缓存 reload，必要时清 session cache/站点数据。
4. 销毁并重建 `WebContentsView`。
5. 子进程连续异常时受控重启应用。
6. Electron 主进程失联时由外部 Watchdog 重启。
7. 确定性规则无法识别时交给 Agent 或人工。

所有恢复都有预算、熔断、证据和业务幂等保护。

### 示教录制

- 输入、鼠标轨迹、URL、viewport、滚动和目标语义。
- DOM/Accessibility、网络和控制台摘要。
- 操作附近 10 FPS 环形帧，静止期变化抽帧。
- 故障前后证据冻结。
- Agent 生成候选 workflow，人确认后版本化。

### Agent

- CodeBuddy SDK 位于 Node sidecar/utility process。
- 只开放结构化浏览器领域工具。
- 不授予 shell、原始 IPC、密钥或任意文件访问。
- 支持 session resume、取消、超时和审计。
- Agent 不作为 BrowserSupervisor 的存活依赖。

## 兼容边界

通常预期支持：

- OAuth/OIDC/SAML SSO。
- WebRTC、摄像头、麦克风和网页屏幕共享。
- Basic Auth、NTLM/Negotiate 和客户端 TLS 证书。
- 标准 HTML5 音视频。

需要真实设备验证：

- WebAuthn、Passkey、Touch ID、Windows Hello。
- 硬件密钥、系统代理/证书库和系统音频。

MVP 明确不做：

- Widevine DRM。
- Chrome Sync 与 Google 浏览器私有 API。
- 完整 Chrome 扩展生态。

## 首个项目

知识星球文本与 MP3 采集：

1. 持久化登录并打开首页。
2. 从检查点扫描帖子。
3. 按关键词、规则或按需 Agent 筛选文本。
4. 打开匹配详情并点击下载 MP3。
5. 将临时文件原子移动到项目输出目录。
6. 记录帖子、附件、文件、校验和和处理状态。
7. 用业务 ID 幂等去重。
8. 在页面或应用故障后恢复。

详见 [知识星球试点](knowledge-planet-pilot.md)。

## 实施阶段

### Phase 0：兼容性与恢复 Spike

- 两个目标站点。
- 注入时序与跨域 frame。
- 登录、SSO、WebRTC、上传下载和弹窗。
- renderer 崩溃、view 重建和 Watchdog。
- 10 FPS 环形录制。
- Windows/macOS 打包。

### Phase 1：内嵌浏览器壳

- BrowserShell、单 Profile/tab。
- `WebContentsView`、session、权限和下载。
- Capability Center。
- Watchdog、健康探针、故障注入和全局监控。

### Phase 2：Strategy MVP

- match/run-at、隔离 world、GM API bridge。
- 配置、权限、日志、心跳和热重载。
- renderer 重建后的策略恢复。

### Phase 3：Project Runtime

当前状态：核心 Runtime、workflow、下载、Filter、工作台和单槽 Scheduler 已实现并通过模拟 MP3 双轮幂等 smoke；真实知识星球和多宿主并行仍待完成。

- Project/Profile 清单。
- 常驻与定时调度、并发预算。
- Workflow、检查点、下载和 Content Filter。
- 项目监控和人工接管。
- 跑通知识星球闭环。

### Phase 4：示教录制

- 事件时间线、关键帧/视频和 DOM/AX。
- 回放器、脱敏、保留与清理。
- 候选 workflow 生成输入。

### Phase 5：Agent 辅助

- CodeBuddy SDK sidecar。
- 受限工具、会话、取消、超时和审计。
- 候选 workflow、未知页面和失败诊断。

## 尚需确定

- 第二个 Phase 0 目标站点。
- 知识星球文本分类规则、历史扫描范围、时区、目录和文件名。
- 登录失效、MFA、验证码和人工接管规则。
- 高风险动作的确认与审计策略。
- Strategy 权限、依赖、资源和版本迁移格式。
- iframe、Shadow DOM、Canvas、多窗口和 DPI 的 MVP 边界。
- 录制数据的脱敏、加密和保留期限。
- Electron 安全升级、签名、公证、回滚和发布 SLA。
