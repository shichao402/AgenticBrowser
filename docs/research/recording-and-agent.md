# 示教录制与 Agent 集成研究

- Date: 2026-10-15
- Status: Research baseline

## 示教数据不能只有视频

仅保存鼠标轨迹和截图，Agent 很难可靠判断点击目标、页面状态和成功条件。一次示教应同步记录：

- 单调时间戳。
- URL、viewport、缩放和滚动位置。
- 鼠标、键盘和焦点事件。
- 目标元素 role、name、text 和候选 selector。
- DOM/Accessibility 快照。
- 网络、控制台和导航摘要。
- 操作前、操作瞬间、稳定后的关键帧。
- workflow/Strategy 上下文。

录制结果是分析素材，不直接等于可执行 workflow。Agent 生成的候选流程仍需补充断言、幂等键、超时、失败边和人工确认。

## 每 100ms 截图的成本

每 100ms 一张即 10 FPS。若逐张保存 1080p 图像，长时间任务可能达到每小时数 GB，并带来 CPU、磁盘和隐私压力。

推荐：

- 内存环形缓冲保存最近一段高频帧。
- 人工操作前后保留 10 FPS。
- 静止期间按视觉变化抽帧并去重。
- 长期连续画面使用视频编码，而不是独立 PNG。
- 故障发生时冻结故障前后的缓冲区。
- 将 DOM/AX 快照与画面帧通过时间戳关联。

正常情况下使用 `webContents.capturePage` 或 Chromium 帧捕获。renderer 已挂死而仍需保留最后窗口画面时，才启用 Windows Graphics Capture 或 macOS ScreenCaptureKit 兜底。

## 输入录制

- 网页内容区：注入式捕获器记录 DOM 输入与语义目标。
- BrowserShell：由本地 React 事件系统记录项目、地址栏和标签操作。
- 跨域 iframe/OOPIF：逐 frame/target 接入。
- 系统授权窗口：不尝试隐藏或静默绕过，记录人工接管边界。

## Agent 的运行位置

CodeBuddy Agent SDK 放在 Electron 主进程外的 Node sidecar 或 utility process：

- 密钥不进入 BrowserShell 或远程页面。
- SDK 故障不影响 BrowserSupervisor 和 Recovery Engine。
- 会话保存 `session_id` 并支持取消、超时和 resume。
- UI 通过结构化事件显示文本、tool call、tool result、artifact、error 和 run end。

## 工具边界

Agent 只获得领域工具：

- `browser.observe`
- `browser.navigate`
- `browser.click`
- `browser.type`
- `browser.wait`
- `browser.assert`
- `browser.reload`
- `browser.clear_cache`
- `workflow.propose`

Tool Gate 必须验证：

- 当前 Project 和 Runtime。
- URL/origin 是否允许。
- selector 或目标是否仍然存在。
- 动作风险等级。
- 文件路径是否在项目目录内。
- 重试和调用预算。

结构化业务结果必须通过工具返回，不能解析 assistant 正文作为控制协议。

## Agent 使用原则

1. 已知流程由确定性 workflow 执行。
2. 新页面或结构漂移先收集证据。
3. Agent 生成候选定位和 workflow。
4. 人确认后固化为版本化策略。
5. 在线自主操作只在规则无法覆盖时启用。
6. 高风险动作必须请求确认或由项目策略明确授权。

## 仍需验证

- `capturePage` 在 10 FPS、多个 view 和长时间运行下的 CPU/内存表现。
- 跨域 frame、Shadow DOM、Canvas 应用的目标语义覆盖率。
- renderer 挂死前后的证据完整性。
- CodeBuddy SDK 流式、取消、超时和 sidecar 重启行为。
- Agent 生成 workflow 的可复现性和人工审核体验。
