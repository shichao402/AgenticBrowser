# Phase 3 Project Runtime 验证记录

- Status: core runtime infrastructure implemented on Windows; real-site pilot and external gates pending
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
- Project 工作台、JSON 编辑、策略版本解析、启动/停止和 Runtime 监控。

当前只有一个受控浏览器宿主，因此全局并发预算为 1：多个项目可以排队和自动执行，但不会并行运行。该限制已经固化在 [ADR-0006](../ADR/0006-persistent-project-runtime-and-download-intent.md)，不能把当前状态描述成真正的多项目并行。

## 自动化验证

### 类型与纯逻辑

```text
npm run typecheck
=> passed

npm test
=> 21 test files passed
=> 101 tests passed
```

覆盖：

- Project 严格解析、原子存储、revision、时区和悬空 workflow 转移拒绝。
- Runtime 状态机、单实例、检查点恢复和跨重启幂等。
- Scheduler 单槽预算、优先级、自动启动、常驻退避、定时到期和 maxRunMs。
- Workflow 导航、领域事件、delay、超时重试、补偿转移和幂等跳过。
- Download Manager 临时提交、文件名、哈希、重复去重、并发预留、配额、磁盘不足、中断记录和 Runtime 下载计数。
- Content Filter allow 优先、资源类型边界和 CSS selector 规则。
- Strategy 领域事件会等待宿主处理，并把 JSON 预授权结果返回页面脚本。

### Electron Project + MP3 闭环

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

### 既有回归

```text
npm run smoke:recovery
=> passed

npm run smoke:strategy-fault
=> passed
```

这证明 Phase 3 改动没有破坏 Windows Profile/session 恢复和同步死循环 Strategy 的 renderer 级隔离门禁。

## 尚未通过的门禁

- 真实知识星球登录、Feed 解析、指定文本分类和真实 MP3 下载。
- 下载过程中强杀 renderer / Electron main 后的端到端续传或安全重试。
- 断网、页面结构变化、登录失效和磁盘不足的 Electron 级故障注入。
- 第二个真实目标站点。
- 多浏览器宿主上的真正多项目并行与资源隔离。
- macOS DMG、签名、公证、Watchdog 和 login item。

上述项目完成前，Phase 3 和知识星球试点仍保持进行中。
