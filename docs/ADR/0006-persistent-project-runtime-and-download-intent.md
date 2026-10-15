# ADR-0006: 持久化 Project Runtime 与下载意图协议

- Status: Accepted
- Date: 2026-10-15

## Context

Project 需要跨导航等待 Strategy 领域事件，并在应用退出、页面崩溃或重复补跑后继续执行。网页点击下载之前，宿主还必须知道文件归属、业务幂等键、输出目录和配额；只监听 Chromium `will-download` 无法可靠补齐这些业务信息。

BrowserShell 同时只能展示一个前台浏览器，但调度器需要让常驻与定时 Project 在后台并行。每个并发槽必须拥有独立 BrowserTabManager、页面、Capability、Strategy allowlist、Content Filter 和下载接管上下文；共享同一 Profile 的 Project 仍必须串行，避免 session handler 和身份状态争用。

## Decision

- Project 定义、Runtime 和下载 manifest 都使用严格 schema v1、原子替换和损坏文件隔离。
- Runtime 保存 Project 完整快照和固定 Strategy 版本；项目后续编辑不改变正在运行或待恢复的实例。
- Scheduler 统一处理 manual、autostart、resident、schedule 和 resume 触发，按项目优先级与触发优先级调度。
- MVP 的全局并发预算为 2。主槽复用前台 BrowserTabManager，第二槽使用隐藏但持续受监督的独立 BrowserTabManager；用户选择运行中的 Project 时切换对应 view 的可见性。
- Scheduler 对正在执行的 `profileId` 加互斥锁；不同 Profile 可并行，共享 Profile 的 Runtime 保持排队，前一实例终态后再启动。
- 应用启动时把中断的 starting/running/waiting/recovering Runtime 恢复为 queued，并从最后检查点重新进入 workflow。
- “暂停并接管”把 Runtime 转为 paused、冻结 workflow deadline，并继续占用原执行槽和 Profile 锁。宿主以同一 Profile 和当前 URL 干净重建页面，但不注入 Strategy，确保旧脚本不能继续抢操作。
- 进程内恢复会重建页面、重新注入固定版本 Strategy，并继续原等待节点；应用重启后的 paused Runtime 不自动运行，只有用户明确恢复时才从最近检查点重新排队。
- Strategy 在触发网页下载前必须发送 `download.intent`。宿主完成权限、项目边界、磁盘、配额和幂等检查后返回 `reserved`、`in-progress`、`duplicate` 或带分类与审计记录的 `rejected`。
- `reserved` 下载先写入项目 `tmp/`，完成后计算 SHA-256，再无覆盖提交到 `downloads/`；状态写入 `records/downloads.json`。
- `rejected` 与传输中断都会先持久化失败 manifest、原子增加 Runtime 失败计数，再通过 `download.failed` 领域事件驱动 workflow；Strategy 不直接获得任意文件系统能力。

## Consequences

正面影响：

- workflow、下载和补跑具有稳定的检查点与业务幂等边界。
- Project 的 Profile、权限、过滤器、策略版本和输出目录可以作为一个可审计快照运行。
- 重复业务附件不会生成第二份文件，Strategy 可以根据 `duplicate` 结果推进流程。
- 调度器不依赖 renderer timer，并能执行运行时长预算。

代价与限制：

- 两槽预算是显式资源上限，不代表无限扩容；更多并发槽需要资源压测和用户可配置预算。
- 前台只展示一个 Project，后台页面仍保持健康探针、Strategy、workflow 和下载；全局监控聚合所有槽，事件携带 Project/Runtime 归属。
- 人工接管保留 Cookie、LocalStorage、Profile 和当前 URL，但干净重建会丢失未持久化 DOM、表单与页面内 JavaScript 状态；这是可靠停掉任意 Strategy 的明确代价。
- schema v1 workflow 目前只提供 navigate、delay、wait-for-event 和 complete；复杂断言与更多动作仍需后续版本。
- 定时调度使用本机时钟和 IANA 时区；MVP 不补跑当天当前时刻之前的所有历史触发点。

## Rejected alternatives

- 让 Strategy 直接写文件：绕过项目目录、配额、审计和幂等边界。
- 仅依赖 `will-download` 猜测业务归属：无法稳定关联帖子、附件和 workflow 节点。
- 在单一浏览器上下文中并行切换多个 Project 配置：会造成 Profile、权限、过滤和下载串扰。
- 只把 Runtime 保存在内存：应用重启后无法可信续跑。
