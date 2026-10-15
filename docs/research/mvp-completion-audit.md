# MVP 完成度审计

- Status: Windows Phase 0–3 core accepted; MVP not complete
- Date: 2026-10-15
- Audited host: Windows 11 24H2 (`10.0.26100`)
- Runtime: Electron 44.7.2, Node.js 22+

## 结论

当前仓库已经具备可运行的 Windows MVP 核心：内嵌 Chromium、受控 BrowserShell、Profile/session、Strategy、Project workflow、双槽调度、下载事务、监控、人工接管和分级恢复均有实现及自动化证据。Selenium 与 Test Pages 两个无需账号的公开真实站点已在同一 Project 中完成跨域闭环。

整个 MVP 仍不能标记为完成，原因是路线图要求的 macOS 门禁和部分 Electron 级故障矩阵尚未闭合。示教录制与 Agent 操作浏览器属于 Phase 4/5，也尚未实现，因此当前状态不能称为完整产品。

## 已通过的自动化证据

最终工程基线：

```text
npm run check
=> typecheck passed
=> 23 test files / 115 tests passed
=> production build passed
=> production dependency audit: 0 known vulnerabilities
```

Windows Electron 门禁：

- `npm run smoke:electron`：页面隔离、document-start、same-origin/cross-origin frame、renderer 崩溃重建、Profile 保持和 10 FPS 截图环通过。
- `npm run smoke:recovery`：加载失败、精确 Origin 能力、权限/弹窗/下载、Profile/session、多 tab、四级恢复和熔断通过。
- `npm run smoke:strategy-fault`：Strategy 心跳、超时、同步死循环隔离和 renderer 重建恢复通过。
- `npm run smoke:strategy-workspace`：Strategy 编辑、启停、授权与热重载通过。
- `npm run smoke:project-download`：下载预授权、临时文件、SHA-256、原子提交和幂等通过。
- `npm run smoke:project-concurrency`：双执行槽、不同 Profile 并行、共享 Profile 互斥和输出隔离通过。
- `npm run smoke:project-takeover`：人工接管、等待预算冻结、Strategy 暂停和同 Runtime 恢复通过。
- `npm run smoke:automation-playground`：双公开真实站点三轮流程通过。
- `npm run smoke:watchdog`：Electron main 强杀后外部 Watchdog 重启及 URL/Profile 检查点恢复通过。
- `npm run smoke:watchdog:packaged`：Windows packaged 入口、重复启动锁、Watchdog 恢复和 login item 能力探测通过。

持续集成：

- `.github/workflows/ci.yml` 在 `main` push、Pull Request 和手动触发时使用 Node.js 22 的 `windows-latest` 执行 `npm ci` 与 `npm run check`。
- 该 CI 是快速工程基线，不包含 Electron GUI、打包 Watchdog或外部真实站点 smoke；这些门禁当前仍需本地或发布前显式执行，不能把 `CI passed` 等同于完整 MVP 验收。

## 双公开站点验收

同一固定版本 Project/Strategy 跨以下站点运行：

1. Selenium 官方浏览器测试资源：表单提交、延迟 DOM、固定 HTTPS 文件下载。
2. Test Pages 动态同步挑战：跨域导航后依次完成四阶段延迟按钮，并断言 `All Buttons Clicked`。

三个 Runtime 分别覆盖正常执行、renderer 崩溃后续跑、页面漂移后暂停并人工修复。三轮均完成，业务计数均为 `scanned=4`、`matched=4`、`skipped=0`；最终只有一个 14-byte 下载，SHA-256 和临时目录状态正确。

这证明了真实网络下的页面操作、跨域 workflow、动态 DOM、下载幂等、renderer 恢复和人工接管，不证明任意生产网站、登录体系或反自动化策略都兼容。知识星球试点已经取消，不访问真实账号或生产数据。

## 按阶段审计

### Phase 0

Windows 工程、页面隔离、frame/OOPIF 注入、主动心跳、renderer/main 故障恢复、检查点、截图环和安装启动已有证据。Chromium 原生 `unresponsive`/`responsive` 事件因触发慢且不稳定，只保留辅助观测；短周期主动 heartbeat 是实际监督主信号。

未闭合：macOS 构建、签名、公证和启动。

### Phase 1

BrowserShell、多 tab、Named Profile、精确 Origin Capability、健康监测、恢复预算、熔断、下载接管、结构化日志、全局监控和 Windows Watchdog 已闭合。Profile 的 Project 引用保护及完整下载事务已由 Phase 3 补齐。

未闭合：Windows 登录项实际写入及重启自启 E2E，以及 macOS Watchdog 与 login item 实机证据。

### Phase 2

Strategy manifest、URL/frame/run-at 匹配、隔离 world、受控宿主 API、权限、心跳、错误归因、故障隔离、热重载和编辑 UI 已闭合。

### Phase 3

Project/Profile/Runtime、固定 Strategy 版本、workflow/checkpoint、Scheduler、双槽与 Profile 互斥、下载事务、Content Filter、监控和人工接管已闭合。双公开站点验收已通过。

未闭合：下载过程中强杀 renderer/main、断网和磁盘不足的 Electron 端到端故障门禁。

## 阻止 MVP 完成的门禁

1. 在 Electron 层注入断网，确认故障被分类、按预算恢复或进入可接管状态。
2. 在真实下载过程中强杀 renderer 和 Electron main，确认重启后不会提交损坏文件或重复业务附件，并能安全重试。
3. 在 Electron 层模拟磁盘不足，确认临时文件、manifest、Runtime 计数和错误分类一致。
4. 在 macOS 实机或可信 runner 验证 DMG、签名、公证、Watchdog、login item 和基本真实站点闭环。

## 不阻止当前 Windows 核心验收，但发布前必须处理

- 当前并发预算固定为 2；两槽以上压测和用户可配置预算尚未实现。
- Pull Request CI 当前只执行 `npm run check`；Electron smoke、打包产物断言和真实站点结果尚未纳入自动归档门禁。
- Windows 构建仍使用默认 Electron 图标，正式代码签名、SmartScreen、自动升级和回滚未闭合。
- 长时间常驻压力、资源泄漏、代理/证书、WebAuthn、音视频和企业登录需要按实际业务环境验证。
- 真实业务项目、登录失效、MFA、验证码、数据规则和高风险操作审批尚未确定。

## MVP 之后

- Phase 4：人工示教录制、鼠标轨迹、DOM/Accessibility、关键帧证据、脱敏与回放。
- Phase 5：CodeBuddy SDK sidecar、受限浏览器工具、Agent 会话、取消/超时和审计。

在以上两阶段完成前，AgenticBrowser 是确定性自动化与恢复运行时，不是已经具备“人教几次后由 Agent 自动学会”的最终产品。
