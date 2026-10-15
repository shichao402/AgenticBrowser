# AgenticBrowser 文档

本目录是产品、架构和实施状态的事实来源。

## 目录职责

### `ADR/`

记录已经接受或正在讨论的关键技术决策及其取舍。ADR 解释“为什么这样选”，不承担完整架构说明。

### `architecture/`

描述当前有效的系统设计、组件边界、领域模型、数据流、安全和恢复机制。实现改变时必须同步更新。

### `research/`

保存方案比较、外部能力调查、兼容性边界和仍需验证的假设。研究结论被正式采用后，应由 ADR 固化。

### `roadmap/`

维护产品总计划、阶段范围、首个试点和验收标准。完成状态应与仓库当前实现一致。

## 当前阅读顺序

1. [产品总计划](roadmap/product-plan.md)
2. [总体架构](architecture/overview.md)
3. [产品领域模型](architecture/product-model.md)
4. [MVP 路线图](roadmap/mvp.md)
5. [知识星球试点](roadmap/knowledge-planet-pilot.md)
6. [浏览器内核与兼容性研究](research/browser-runtime-and-compatibility.md)
7. [示教录制与 Agent 研究](research/recording-and-agent.md)
8. [架构决策记录](ADR/README.md)

## 同步原则

- roadmap 描述“准备做什么、做到什么算完成”。
- architecture 描述“系统现在如何工作”。
- ADR 描述“关键方向为何如此决定”。
- research 描述“比较过什么、证据和未知项是什么”。

不要只修改代码而让架构文档继续描述旧行为；也不要提前把尚未实现的设计写成已经存在的能力。
