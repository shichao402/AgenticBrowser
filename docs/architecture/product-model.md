# 产品领域模型

> 状态：目标模型，数据格式将在 Phase 1–3 中通过迁移版本固化。

## Strategy

Strategy 是类似 Tampermonkey userscript 的页面局部能力。

schema v1 字段：

```yaml
id: feed-scanner
version: 0.1.0
matches:
  - https://example.com/feed/*
excludes: []
runAt: document-idle
frames: top
permissions:
  - dom.read
  - dom.click
  - project.emit-event
networkMatches: []
config: {}
timeouts:
  startupMs: 10000
  heartbeatMs: 30000
```

约束：

- Strategy 必须同时满足 URL 匹配和 Project allowlist。
- Project 固定 Strategy 版本。
- Strategy 不能直接读写任意文件、调用 shell 或控制其他项目。
- Strategy 应通过领域事件报告完成、等待、失败和业务发现。
- `matches`、`excludes` 与 `networkMatches` 只接受结构化 HTTP(S) pattern；非 Web URL 默认拒绝。
- manifest、源码、启停状态与更新时间保存在版本化注册表中；未知字段和未知权限默认拒绝。

schema、校验、存储、匹配、隔离执行、宿主 API、心跳和故障隔离已经实现；Project 固定版本将在 Phase 3 取代临时开发 allowlist。`dom.read/write/click` 是声明与审计信息，不是把同一 DOM 内的任意 JavaScript 强制拆成三种安全权限；文件、特权网络和领域事件等宿主能力由主进程独立校验。页面原生 `fetch`/XHR 仍服从普通 Web 安全规则，`network.request` 只表示允许使用宿主增强请求；同理，`main-world` 只控制宿主执行桥，不是对 DOM 脚本注入的绝对防线。

## Project

Project 是用户直接启动、停止、调度和监控的单元。

建议字段：

```yaml
id: knowledge-planet-audio
name: 知识星球语音采集
profile: personal-knowledge-planet
startupPages:
  - https://example.com/home
strategies:
  feed-scanner: 0.1.0
  text-classifier: 0.1.0
  audio-downloader: 0.1.0
runtime:
  mode: schedule
  timezone: Asia/Shanghai
  concurrency: 1
output:
  root: user-selected-directory
capabilities:
  defaults:
    popups: false
    downloads: true
    media: false
  origins:
    - origin: https://example.com
      overrides:
        popups: true
  agent: optional
```

Project 还拥有：

- workflow 版本与入口。
- Content Filter 规则集。
- 重试、熔断和补跑策略。
- 下载命名、覆盖、去重和配额。
- 项目级 secrets 引用。

## Profile

Profile 是命名身份容器，映射到持久化 Electron session partition。

- 默认每个 Project 独立。
- 用户可让多个 Project 显式引用同一个 Profile。
- Profile 共享只影响 Cookie、缓存、存储和登录身份，不合并页面、workflow 或输出目录。
- 删除 Profile 必须提示会清除登录状态，并检查引用它的项目。

## Project Runtime

Runtime 表示 Project 的一次活跃执行：

- `runtimeId`
- Project 与配置快照版本
- 状态：queued、starting、running、waiting、recovering、paused、failed、completed
- 当前 workflow 节点
- 活跃 page/tab
- 最近检查点
- 重试与熔断预算
- 四级心跳
- 资源与下载统计

常驻 Project 可以长期保持同一个 Runtime；定时 Project 每次运行生成新的 Runtime 记录。

## Workflow

Workflow 是跨页面状态机，不是录制动作列表。

每个节点至少包含：

- 前置条件。
- 动作或等待。
- 成功断言。
- 失败分类。
- 超时和重试预算。
- 幂等键。
- 检查点。
- 下一节点或补偿节点。

Strategy 可以向 workflow 发出领域事件，但不能随意跳转全局状态。

## Filter

Filter 是按 Project 启用的干扰控制规则：

- 网络 URL 与资源类型阻断。
- 页面 CSS/selector 隐藏。
- 明确 allowlist。
- 命中日志。

MVP Filter 不允许默认阻断主文档、认证、业务 API 和下载。

## Download Record

下载记录至少保存：

- Project、Runtime 和 workflow 节点。
- 来源页面、业务项 ID、附件 ID/URL。
- 原始文件名、安全文件名和最终路径。
- MIME、大小、校验和。
- started/completed/failed 状态和时间。
- 错误分类与重试次数。

业务项 ID 与附件 ID/URL 组成幂等键，防止补跑时重复下载。
