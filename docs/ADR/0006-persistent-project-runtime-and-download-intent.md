# ADR-0006: 持久化 Project Runtime 与下载意图协议

- Status: Accepted
- Date: 2026-10-15

## Context

Project 需要跨导航等待 Strategy 领域事件，并在应用退出、页面崩溃或重复补跑后继续执行。网页点击下载之前，宿主还必须知道文件归属、业务幂等键、输出目录和配额；只监听 Chromium `will-download` 无法可靠补齐这些业务信息。

当前 BrowserShell 只有一个可见的受控浏览器宿主。直接同时运行多个 Project 会让 Profile、Capability、Strategy allowlist、Content Filter 和下载接管争用同一个 session/view 上下文。

## Decision

- Project 定义、Runtime 和下载 manifest 都使用严格 schema v1、原子替换和损坏文件隔离。
- Runtime 保存 Project 完整快照和固定 Strategy 版本；项目后续编辑不改变正在运行或待恢复的实例。
- Scheduler 统一处理 manual、autostart、resident、schedule 和 resume 触发，按项目优先级与触发优先级调度。
- MVP 的全局并发预算固定为 1。多个项目可以同时排队、自动唤醒和顺序执行，但在多宿主架构落地前不宣称真正并行。
- 应用启动时把中断的 starting/running/waiting/recovering Runtime 恢复为 queued，并从最后检查点重新进入 workflow。
- Strategy 在触发网页下载前必须发送 `download.intent`。宿主完成权限、项目边界、磁盘、配额和幂等检查后返回 `reserved` 或 `duplicate`。
- `reserved` 下载先写入项目 `tmp/`，完成后计算 SHA-256，再无覆盖提交到 `downloads/`；状态写入 `records/downloads.json`。
- Download Manager 通过 `download.completed` / `download.failed` 领域事件驱动 workflow，Strategy 不直接获得任意文件系统能力。

## Consequences

正面影响：

- workflow、下载和补跑具有稳定的检查点与业务幂等边界。
- Project 的 Profile、权限、过滤器、策略版本和输出目录可以作为一个可审计快照运行。
- 重复业务附件不会生成第二份文件，Strategy 可以根据 `duplicate` 结果推进流程。
- 调度器不依赖 renderer timer，并能执行运行时长预算。

代价与限制：

- 单槽预算意味着“多个项目自动运行”当前是排队串行，不是并行。
- 真正并行需要每个执行槽拥有独立 BrowserTabManager/视图上下文，并重新设计前台切换和资源归属。
- schema v1 workflow 目前只提供 navigate、delay、wait-for-event 和 complete；复杂断言与更多动作仍需后续版本。
- 定时调度使用本机时钟和 IANA 时区；MVP 不补跑当天当前时刻之前的所有历史触发点。

## Rejected alternatives

- 让 Strategy 直接写文件：绕过项目目录、配额、审计和幂等边界。
- 仅依赖 `will-download` 猜测业务归属：无法稳定关联帖子、附件和 workflow 节点。
- 在单一浏览器上下文中并行切换多个 Project 配置：会造成 Profile、权限、过滤和下载串扰。
- 只把 Runtime 保存在内存：应用重启后无法可信续跑。
