# Phase 3 Project Runtime 验证记录

- Status: core runtime and one public real-site gate implemented on Windows; external gates pending
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
- 业务项持久化、筛选计数、Selenium 官方测试页面模板，以及页面变化自动转人工接管。
- Runtime 计数器使用独立原子增量，不再依赖调用方读取到的旧状态，避免页面领域事件与 workflow 状态迁移竞态。

当前全局并发预算为 2：前台主槽与独立后台 BrowserTabManager 可以同时执行不同 Profile 的 Project；共享 Profile 的 Project 由调度器保持排队。前台选择会切换对应 view，可见性不会停止后台健康监督和 workflow。

## 自动化验证

### 类型与纯逻辑

```text
npm run typecheck
=> passed

npm test
=> 23 test files passed
=> 115 tests passed
```

覆盖：

- Project 严格解析、原子存储、revision、时区和悬空 workflow 转移拒绝。
- Runtime 状态机、单实例、检查点恢复和跨重启幂等。
- Scheduler 单/双槽预算、Profile 互斥、优先级、自动启动、常驻退避、定时到期和 maxRunMs。
- Workflow 导航、领域事件、delay、超时重试、补偿转移和幂等跳过。
- Download Manager 临时提交、文件名、哈希、重复去重、并发预留、配额、磁盘不足、中断记录和 Runtime 下载计数。
- Content Filter allow 优先、资源类型边界和 CSS selector 规则。
- Strategy 领域事件会等待宿主处理，并把 JSON 预授权结果返回页面脚本。
- 接管暂停/恢复、暂停期间领域事件拒绝、跨重启 paused Runtime 重排队，以及暂停槽/Profile 锁不被调度器复用。
- 业务项存储、跨 Runtime seen count、损坏文件隔离、Selenium 验收模板 schema，以及不依赖 Runtime 旧状态的原子计数。

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

### Electron Selenium 公开真实站点闭环

```text
npm run smoke:automation-playground
=> passed
```

目标为 Selenium 官方公开浏览器测试资源 `https://www.selenium.dev/selenium/web/`，无需账号，不写入远端业务数据。门禁执行三个 Runtime：

1. 第一轮填写文本、文本域、下拉框和复选框，经 GET 提交并验证结果；随后等待延迟 DOM，输入新出现的控件，最后下载官方测试文件。
2. 第二轮在 `wait-dynamic` workflow 节点强制终止 renderer。BrowserSupervisor 重建 view，Strategy 重新注入并从同一节点继续；既有下载命中幂等记录。
3. 第三轮从同域不存在路径启动。业务断言发送 `project.page-changed`，宿主自动暂停；人工导航回表单页后恢复同一 Runtime 并完成。

三个 Runtime 均为 completed，每轮计数均为 scanned=3、matched=3、skipped=0。最终 `records/items.json` 只有 form、dynamic、download 三条记录，seen count 均为 3；`records/downloads.json` 和 `downloads/` 均只有一个 completed 文件，`tmp/` 为空。文件内容为 `Hello, World!\n`，14 bytes，SHA-256 为 `c98c24b677eff44860afea6f493bbaec5bb1c4cbb209c6fc2bbb47f66ff2ad31`。第二轮证据包含 renderer generation 增长以及 `renderer-gone`、`recovery-succeeded`、`recreated`；第三轮暂停原因分类为 `page-changed`，paused/resumed 事件各一条。

该门禁证明了真实网络下的页面操作、跨页面 workflow、延迟 DOM、HTTPS 下载、幂等、renderer 崩溃恢复和页面漂移接管。它不证明任意生产网站兼容，完整范围见 [Selenium 自动化验收试点](../roadmap/automation-playground-pilot.md)。

## 尚未通过的门禁

- 下载过程中强杀 renderer / Electron main 后的端到端续传或安全重试。
- 断网、登录失效和磁盘不足的 Electron 级故障注入；页面变化门禁已通过。
- 第二个真实目标站点。
- 两槽以上的资源预算压测与可配置并发上限。
- macOS DMG、签名、公证、Watchdog 和 login item。

知识星球试点因登录和账号风控风险已按用户要求取消，未进行真实账号自动化；底层通用 Runtime 能力保留。Phase 3 核心基础设施和首个公开真实站点门禁已经完成，完整故障矩阵、第二站点与 macOS 门禁完成前，整个 MVP 仍保持进行中。
