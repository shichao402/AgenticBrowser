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

首个真实项目是知识星球采集：

1. 复用持久化登录状态并按计划打开首页。
2. 扫描新帖子并筛选指定类型文本。
3. 打开匹配内容并下载其中的 MP3。
4. 将文件安全写入项目目录，保存来源元数据并避免重复下载。
5. 在页面或应用故障后恢复并续跑。

MVP 不包含 Widevine DRM、Chrome Sync、Google 浏览器私有 API或完整 Chrome 扩展生态。

## 文档

- [文档索引](docs/README.md)
- [总体架构](docs/architecture/overview.md)
- [产品领域模型](docs/architecture/product-model.md)
- [浏览器内核研究](docs/research/browser-runtime-and-compatibility.md)
- [产品总计划](docs/roadmap/product-plan.md)
- [MVP 路线图](docs/roadmap/mvp.md)
- [知识星球试点](docs/roadmap/knowledge-planet-pilot.md)
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
npm run smoke:recovery
npm run smoke:watchdog
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

项目处于 Phase 1：Phase 0 已完成 Windows 工程、隔离注入、renderer/main 故障恢复、URL/Profile 检查点、受限截图环和安装验证；macOS 与真实站点门禁仍待外部环境。当前已实现多 tab、主动页面健康监测、分级恢复预算与熔断、本地错误页、Capability Center、受控弹窗、基础下载接管、JSONL 事件日志和 CPU/内存/页面/下载监控。完整 Profile 管理和 Phase 3 下载事务仍待完成。证据见 [Phase 0](docs/research/phase0-validation.md) 与 [Phase 1 验证记录](docs/research/phase1-validation.md)。
