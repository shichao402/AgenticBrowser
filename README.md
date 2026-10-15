# AgenticBrowser

AgenticBrowser 是一个面向 Windows 和 macOS 的内嵌式自动化浏览器。

它使用 Electron/Chromium 承载目标网页，以“项目”为运行和调度单元，以“策略”为 URL 匹配后的页面自动化单元，并由独立监督者负责页面故障恢复、状态检查点和 Agent 工具调用。

## 产品目标

- 在自有客户端窗口中嵌入网页、标签页、地址栏、项目与监控界面。
- 提供类似 Tampermonkey 的 URL 匹配策略，但不依赖浏览器扩展。
- 用显式 workflow 编排跨页面流程，并支持常驻监听、定时唤醒和多项目并发。
- 在加载失败、页面无响应、renderer 崩溃或应用重启后，从持久化检查点恢复。
- 记录人工示教的输入、DOM/Accessibility、关键帧和上下文，生成可审核的自动化流程。
- 通过受限工具接入 Agent；确定性流程和恢复能力不依赖 Agent 在线。

## MVP

首个真实站点验收项目跨 Selenium 与 Test Pages 两个公开自动化测试网站：

1. 自动填写表单、选择下拉框和复选框，并验证跨页面提交结果。
2. 等待延迟 DOM 出现后继续输入和 workflow。
3. 从真实 HTTPS 页面下载固定测试文件，校验大小与 SHA-256，并避免重复下载。
4. 跨域进入 Test Pages，等待并依次点击四阶段动态按钮，验证最终完成断言。
5. renderer 崩溃后重建页面并从当前 workflow 节点续跑。
6. 页面断言失败时自动暂停，人工导航修复后恢复同一 Runtime。

这两个站点均无需账号，流程不写入远端业务数据。首个实际业务项目将在核心门禁稳定后另行确定。

MVP 不包含 Widevine DRM、Chrome Sync、Google 浏览器私有 API或完整 Chrome 扩展生态。

## 文档

- [文档索引](docs/README.md)
- [总体架构](docs/architecture/overview.md)
- [产品领域模型](docs/architecture/product-model.md)
- [浏览器内核研究](docs/research/browser-runtime-and-compatibility.md)
- [产品总计划](docs/roadmap/product-plan.md)
- [MVP 路线图](docs/roadmap/mvp.md)
- [公开自动化测试站点验收试点](docs/roadmap/automation-playground-pilot.md)
- [MVP 完成度审计](docs/research/mvp-completion-audit.md)
- [架构决策记录](docs/ADR/README.md)

## 开发

要求 Node.js 22 或更高版本。

```bash
npm install
npm run dev
```

验证完整工程基线：

```bash
npm run check
```

验证 renderer 故障与应用外 Watchdog 恢复：

```bash
npm run smoke:electron
npm run smoke:strategy-fault
npm run smoke:strategy-workspace
npm run smoke:project-download
npm run smoke:project-download-recovery
npm run smoke:project-concurrency
npm run smoke:project-takeover
npm run smoke:automation-playground
npm run smoke:recovery
npm run smoke:watchdog
npm run smoke:watchdog:packaged
```

构建本地安装包：

```bash
npm run dist
```

核心源码：

- `src/main/`：Electron 主进程和 Browser Supervisor。
- `src/preload/`：BrowserShell 的最小 IPC bridge。
- `src/renderer/`：React BrowserShell。
- `src/shared/`：跨进程结构化契约。
- `tests/`：纯逻辑与后续故障回归测试。

## 当前状态

Phase 0–3 核心已落地：Phase 0 完成 Windows 工程、隔离注入、renderer/main 故障恢复、URL/Profile 检查点、受限截图环和安装验证；Phase 1 实现多 tab、Profile/session、主动健康监测、分级恢复与熔断、精确 Origin Capability Center、下载接管、Watchdog/登录启动接口、事件日志和进程监控；Phase 2 完成 Strategy manifest、隔离执行、受控宿主 API、心跳/故障隔离和编辑 UI；Phase 3 完成 Project/Profile/Runtime、固定版本 allowlist、持久化 workflow、双槽调度与 Profile 互斥、项目级 Capability/Content Filter、下载事务、人工接管和工作台。Selenium 与 Test Pages 两个公开真实站点上的表单、延迟 DOM、跨域 workflow、HTTPS 下载、幂等、renderer 崩溃恢复和页面变化接管已经通过 Electron 闭环；下载过程中强杀 Electron main 后的 Watchdog/Runtime 安全重试也已通过。断网、磁盘不足、单独强杀下载 renderer、系统登录项重启自启 E2E 与 macOS 门禁仍未完成。证据见 [Phase 0](docs/research/phase0-validation.md)、[Phase 1](docs/research/phase1-validation.md)、[Phase 2](docs/research/phase2-validation.md) 与 [Phase 3 验证记录](docs/research/phase3-validation.md)。
