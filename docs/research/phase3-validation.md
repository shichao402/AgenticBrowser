# Phase 3 Project Runtime 验证记录

- Status: core runtime and two public real-site gates implemented on Windows; external gates pending
- Date: 2026-10-15
- Environment: Windows 11 24H2, Electron 44.7.2, Node.js 22+

## 已实现范围

- 严格 schema v1 的 Project、Project Runtime 和下载 manifest。
- Project 固定 Strategy 版本、Profile 引用、Capability、Content Filter、输出与重试配置。
- Runtime 单项目实例锁、Project 快照、状态迁移、检查点、计数器、启动中断恢复和幂等记录。
- navigate、delay、wait-for-event、complete workflow 节点，以及超时、分类重试和失败转移。
- manual、autostart、resident、schedule、resume 调度；IANA 时区 daily/interval 判断、优先级、最大运行时长和全局并发预算。
- `download.intent` 预授权、`tmp/` 临时文件、SHA-256、配额/磁盘检查、无覆盖提交、manifest 和重复附件去重。
- 项目级网络/CSS Content Filter。
- Project 工作台、JSON 编辑、策略版本解析、启动/暂停接管/恢复/停止和 Runtime 监控。
- 人工接管期间冻结 workflow 等待预算、禁用所有 Project Strategy，并继续占用浏览器槽与 Profile 互斥。
- 业务项持久化、筛选计数、双公开测试站点模板，以及页面变化自动转人工接管。
- Runtime 计数器使用独立原子增量，不再依赖调用方读取到的旧状态，避免页面领域事件与 workflow 状态迁移竞态。

当前全局并发预算为 2：前台主槽与独立后台 BrowserTabManager 可以同时执行不同 Profile 的 Project；共享 Profile 的 Project 由调度器保持排队。前台选择会切换对应 view，可见性不会停止后台健康监督和 workflow。

## 自动化验证

### 类型与纯逻辑

```text
npm run typecheck
=> passed

npm test
=> 25 test files passed
=> 124 tests passed
```

覆盖：

- Project 严格解析、原子存储、revision、时区和悬空 workflow 转移拒绝。
- Runtime 状态机、单实例、检查点恢复和跨重启幂等。
- Scheduler 单/双槽预算、Profile 互斥、优先级、自动启动、常驻退避、定时到期和 maxRunMs。
- Workflow 导航、领域事件、delay、超时重试、补偿转移和幂等跳过。
- Download Manager 临时提交、文件名、哈希、重复去重、并发预留、配额、可审计磁盘拒绝、同 Runtime 重入去重、中断记录、无后缀安全重试和 Runtime 成功/失败计数。
- Content Filter allow 优先、资源类型边界和 CSS selector 规则。
- Strategy 领域事件会等待宿主处理，并把 JSON 预授权结果返回页面脚本。
- 接管暂停/恢复、暂停期间领域事件拒绝、跨重启 paused Runtime 重排队，以及暂停槽/Profile 锁不被调度器复用。
- 业务项存储、跨 Runtime seen count、损坏文件隔离、双站点验收模板 schema，以及不依赖 Runtime 旧状态的原子计数。

### Electron 本地 Project + 下载闭环

```text
npm run smoke:project-download
=> passed
```

探针执行两轮同一 Project：

1. 创建并绑定独立 Profile。
2. 解析固定版本 Strategy 并只在 Project allowlist 中运行。
3. workflow 导航后等待 `download.completed`。
4. Strategy 发送 `download.intent`，再点击 4,096-byte 模拟 MP3。
5. Content Filter 命中网络 image 阻断和 CSS selector 规则。
6. 下载写入 `tmp/`，计算 SHA-256 后提交到 `downloads/`。
7. workflow 收到宿主领域事件并完成。
8. 第二轮识别相同业务附件，复用完成记录，不产生第二个文件。
9. 终态后恢复开发态 Strategy 配置，活动 Strategy 数回到 0。

观测结果：

- 下载 manifest 只有 1 条 completed 记录。
- 最终目录只有 1 个 MP3，`tmp/` 为空。
- 文件大小为 4,096 bytes，SHA-256 与探针内容一致。
- 两次 Runtime 均为 completed，检查点都包含 `download.completed`。
- 项目 Profile 保持活动，Filter 命中事件可见。

### Electron 多 Project 并发

```text
npm run smoke:project-concurrency
=> passed
```

- 两个不同 Profile 的 Project 在两个独立 BrowserTabManager 中同时处于运行态。
- 全局监控在重叠窗口观测到 2 个活动 Project、2 个页面和 2 个排队 Project。
- 停止其中一个排队 Project 不会打断两个活动执行槽；另一个共享 Profile 的 Project 保持排队，并在前序实例终态后启动。
- 三个执行 Runtime 均完成、被停止的排队 Runtime 正确取消；两个 session partition 的 Cookie 证明并行 Profile 未互相读取身份状态。
- 三个项目各自完成 4,096-byte MP3，manifest、最终目录与临时目录互不串扰。
- 复验曾命中“下载已预留、页面在点击前重建”的窗口；Strategy 现在对 `in-progress + canStart` 重入结果继续触发已预留下载，修复后同一门禁再次通过，不再留下 reserved 记录。

### 既有回归

```text
npm run smoke:recovery
=> passed

npm run smoke:strategy-fault
=> passed
```

这证明 Phase 3 改动没有破坏 Windows Profile/session 恢复和同步死循环 Strategy 的 renderer 级隔离门禁。

### Electron 人工接管

```text
npm run smoke:project-takeover
=> passed
```

探针先在主槽运行 blocker，再在独立 Profile 的后台槽运行一个等待领域事件的 Project：

1. 两个 Runtime 同时进入 `waiting`，接管目标的 Project Strategy 在后台槽保持运行。
2. “暂停并接管”把 Runtime 转为 `paused`，冻结等待截止时间并重建无 Strategy 的页面。
3. 暂停期间通过 BrowserShell 导航模拟用户完成登录或修复页面；Runtime 仍为 paused，活动 Strategy 数为 0。
4. “恢复自动化”重新注入固定版本 Strategy，页面发出完成事件，原 Runtime 从同一 workflow 节点完成。

观测结果：

- 暂停监控为 1 个 active blocker、1 个 paused Project、2 个页面和 0 个活动 Strategy，页面仍健康且可导航。
- 恢复后 checkpoint 保存 `takeover.completed`，Runtime 为 completed。
- `project-runtime-paused` 与 `project-runtime-resumed` 事件均携带 Project/Runtime 归属。
- 暂停 Runtime 在 Scheduler 中继续占用执行槽和 Profile 锁。

### Electron main 下载中强杀与安全重试

```text
npm run smoke:project-download-recovery
=> passed
```

独立 Watchdog 启动一个持久化 Project Runtime，从本地 HTTP 端点下载 1 MiB 的慢速文件。探针在 manifest 已进入 `downloading` 且 `.part` 已写入部分字节时，从应用外强杀 Electron main：

1. Watchdog 启动第二个 Electron PID，应用把同一 Runtime 从 `wait-download` 检查点以 `trigger=resume` 重新排队。
2. Download Manager 将首次未完成记录分类为 `failed/unknown`，保留部分 `.part` 作为故障证据，不把它提交到最终目录。
3. 相同业务幂等键重新预留并完整下载；失败记录不再无谓占用最终文件名，重试沿用原安全文件名。
4. 新文件完成 SHA-256 校验和原子提交后，同一 Runtime 进入 `completed`。

最终只有一个完整文件，大小为 1,048,576 bytes，SHA-256 为 `bf63d8a95fcc2e64619813aae35fdcbe871fdd9264caa3f365eb3aed0f679129`；manifest 保留一条 failed 证据和一条 completed 记录，Runtime 下载计数和失败计数各增加一次。Watchdog 状态为两次 launch、一次 restart，锁在退出后释放。该门禁证明 Electron main 与其 renderer 一同消失时可以安全重试，但不等同于单独只杀下载页面 renderer。

### Electron session 断网与磁盘不足分类

```text
npm run smoke:project-download-fault
=> passed
```

门禁使用两个独立 Project Runtime：

1. 网络门禁从外部本地 HTTP 服务启动 1 MiB 慢速下载。BrowserSupervisor 在至少收到 32 KiB 后把该 Profile session 切为 offline；由于 Chromium 的离线仿真不会终止已经建立的传输连接，诊断器同时中止当前 DownloadItem，并明确以 `diagnostic-offline` 归因为 `network`。
2. 网络 manifest 只有一条 `failed/network`，没有最终文件；Windows Chromium 在取消时清理了部分临时文件。下载监控仍记录了超过阈值的接收字节，Runtime 失败计数为 1，`download.failed` 检查点携带 `category=network`，workflow 按预期完成。
3. 磁盘门禁声明 2 MiB 附件和 1 MiB Project 配额。宿主在任何 HTTP 下载请求发生前返回 `rejected`，写入唯一一条 `failed/disk` manifest，并投递分类事件。
4. Strategy 因页面重建重复注入时，宿主按 Runtime + workflow 节点 + 业务幂等键复用同一拒绝记录；磁盘 Runtime 失败计数只增加一次，`downloads/` 与 `tmp/` 均为空。

外部服务观测到网络文件请求 1 次、磁盘文件请求 0 次。两个 Runtime 都通过显式失败分支进入 `completed`，而不是超时或无限重试。该门禁证明 Electron session 离线和下载配额不足的宿主分类；它不等同于耗尽真实文件系统后触发 OS `ENOSPC`。

### 下载中只强杀页面 renderer

```text
npm run smoke:project-download-renderer-recovery
=> passed
```

独立父进程提供 2 MiB 慢速下载。Electron 子进程在 manifest 为 `downloading` 且 `.part` 已写入 16 KiB 后，仅调用受控页面 `WebContents.forcefullyCrashRenderer()`：

1. Electron main PID 保持不变，BrowserSupervisor generation 从 4 增至 5，并依次记录 `renderer-gone`、`recreated` 与 `recovery-succeeded`。
2. session 级 DownloadItem 不依赖已崩溃的页面 renderer，跨 view 重建继续接收同一 HTTP 响应；外部服务只收到 1 次文件请求。
3. Strategy 在初始重建和崩溃恢复后共启动 3 次，后续 `download.intent` 均识别既有 in-progress 记录，没有触发第二个下载。
4. 同一 Runtime 最终为 `completed`，manifest 只有一条 completed、没有 failed；下载计数为 1、失败计数为 0。
5. 最终文件为 2,097,152 bytes，SHA-256 为 `8f3a655ca195e10693aee21a54719ca92ce1322938e8a7a25355aaa569e78189`，最终目录只有一个文件且 `tmp/` 为空。

下载完成领域事件改为在文件事务提交后异步投递，使 BrowserSupervisor 能在 Runtime 终态切换之前发布带 Project/Runtime 归属的 `download-completed` 事件。该门禁与 Electron main 强杀门禁分别覆盖“session 下载仍存活”和“整个应用消失后安全重试”两条不同恢复路径。

### Electron 双公开真实站点闭环

```text
npm run smoke:automation-playground
=> passed
```

目标为 Selenium 官方浏览器测试资源和 Test Pages 动态同步挑战。两站均无需账号，流程不写入远端业务数据。门禁执行三个 Runtime：

1. 第一轮填写文本、文本域、下拉框和复选框，经 GET 提交并验证结果；随后等待延迟 DOM，输入新出现的控件，下载官方测试文件，再跨域进入 Test Pages 并完成四阶段延迟按钮。
2. 第二轮在 `wait-dynamic` workflow 节点强制终止 renderer。BrowserSupervisor 重建 view，Strategy 重新注入并从同一节点继续；既有下载命中幂等记录。
3. 第三轮从同域不存在路径启动。业务断言发送 `project.page-changed`，宿主自动暂停；人工导航回表单页后恢复同一 Runtime 并完成。

三个 Runtime 均为 completed，每轮计数均为 scanned=4、matched=4、skipped=0。最终 `records/items.json` 只有 form、dynamic、download、testpages-dynamic-buttons 四条记录，seen count 均为 3；每轮最终检查点为 `playground.second-site.completed`，payload 确认 `All Buttons Clicked` 和四个按钮。`records/downloads.json` 和 `downloads/` 均只有一个 completed 文件，`tmp/` 为空。文件内容为 `Hello, World!\n`，14 bytes，SHA-256 为 `c98c24b677eff44860afea6f493bbaec5bb1c4cbb209c6fc2bbb47f66ff2ad31`。第二轮证据包含 renderer generation 增长以及 `renderer-gone`、`recovery-succeeded`、`recreated`；第三轮暂停原因分类为 `page-changed`，paused/resumed 事件各一条。

该门禁证明了真实网络下的页面操作、跨页面 workflow、延迟 DOM、HTTPS 下载、幂等、renderer 崩溃恢复和页面漂移接管。它不证明任意生产网站兼容，完整范围见 [公开自动化测试站点验收试点](../roadmap/automation-playground-pilot.md)。

## 尚未通过的门禁

- 登录失效的 Electron 级故障注入；页面变化、session 断网和磁盘配额不足门禁已通过。
- 真实文件系统 `ENOSPC` 仅由纯逻辑错误映射覆盖，尚未在隔离磁盘/卷上做破坏性注入。
- 两槽以上的资源预算压测与可配置并发上限。
- macOS DMG、签名、公证、Watchdog 和 login item。

知识星球试点因登录和账号风控风险已按用户要求取消，未进行真实账号自动化；底层通用 Runtime 能力保留。Phase 3 核心基础设施和两个公开真实站点门禁已经完成，完整故障矩阵与 macOS 门禁完成前，整个 MVP 仍保持进行中。
