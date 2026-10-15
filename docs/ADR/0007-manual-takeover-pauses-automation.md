# ADR-0007: 人工接管时暂停自动化并保留运行上下文

- Status: Accepted
- Date: 2026-10-15

## Context

登录失效、验证码、MFA 或页面结构变化都可能要求用户直接操作当前页面。若 Strategy、workflow 超时和调度器在人工操作期间继续运行，自动点击可能与用户争用页面，等待节点也可能在接管尚未结束时超时。若直接停止 Runtime，则当前页面、Profile 身份、workflow 检查点和并发归属都会丢失。

## Decision

- `暂停并接管` 只在 workflow 处于稳定等待态时执行，把 Runtime 转为 `paused` 并冻结剩余等待时间。
- BrowserSupervisor 重建当前 view，保留 URL 与命名 Profile，但不加载任何 Project Strategy；用户仍可导航、登录和操作页面。
- 被接管的浏览器继续占用原执行槽和 Profile 互斥锁，其他 Project 不能趁机复用同一身份上下文。
- `恢复自动化` 先恢复 workflow 等待态，再重建 view 并重新注入 Project 固定版本 Strategy；等待预算从暂停前的剩余时间继续计算。
- 进程内恢复保留同一个 Runtime。应用退出后，持久化的 `paused` Runtime 由显式恢复操作从最近检查点重新排队，触发类型记为 `resume`。
- BrowserShell 显示暂停、恢复、停止操作和 paused 项目数；暂停/恢复发布带 Project/Runtime 归属的结构化事件。

## Consequences

正面影响：

- 人工操作期间没有 Strategy 点击、监听器或定时器与用户竞争。
- 登录 Cookie、页面 URL、Project 快照和 workflow 检查点都保留。
- 暂停时间不消耗 workflow 等待预算，且不会绕过全局并发或 Profile 互斥。
- 同一模型同时覆盖前台槽、后台槽和应用重启后的冷恢复。

代价与限制：

- 当前只能在稳定等待态接管；导航或同步动作进行中会拒绝暂停，避免产生不确定的半完成状态。
- 暂停和恢复通过重建 view 清除 Strategy，因此页面内未持久化的临时 JavaScript 状态不会保留。
- MVP 仍需由用户显式点击接管；真实站点的登录失效自动识别和接管提示属于知识星球试点。

## Rejected alternatives

- 只隐藏 Strategy UI 但不停止脚本：页面监听器和定时器仍会继续运行。
- 释放执行槽或 Profile 锁：其他 Runtime 可能同时修改同一 session 和身份状态。
- 接管时取消 Runtime，完成后新建实例：会丢失剩余等待预算和当前执行归属。
- 让 renderer 自己冻结 workflow 计时：后台节流、崩溃和重建后无法可信恢复。
