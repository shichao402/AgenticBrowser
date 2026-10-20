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

### `skills/`

存放面向使用者的 API 说明书，按 Skill 目录结构组织：入口文件加分层
参考文件。动手接入时的第一入口是
[agentic-browser-api](skills/agentic-browser-api/SKILL.md)。

其中签名层由脚本从类型真源生成，`npm run verify:api-docs` 会拦截任何
文档与代码不一致的情况。

本目录作为 Dec 资产发布，声明在 `.dec/config.yaml`，推送后由
`.github/workflows/dec-publish.yml` 自动发到 registry，使用者通过 Dec
订阅安装。所以这里的文档是可以被外部直接消费的产物，改动前先跑
`npm run verify:api-docs`。

## 当前阅读顺序

1. [产品总计划](roadmap/product-plan.md)
2. [总体架构](architecture/overview.md)
3. [产品领域模型](architecture/product-model.md)
4. [MVP 路线图](roadmap/mvp.md)
5. [公开自动化测试站点验收试点](roadmap/automation-playground-pilot.md)
6. [API 说明书（动手接入第一入口）](skills/agentic-browser-api/SKILL.md)
7. [测试与质量门禁](architecture/testing-and-quality-gates.md)
8. [浏览器内核与兼容性研究](research/browser-runtime-and-compatibility.md)
9. [示教录制与 Agent 研究](research/recording-and-agent.md)
10. [Phase 0 验证记录](research/phase0-validation.md)
11. [Phase 1 验证记录](research/phase1-validation.md)
12. [Phase 2 验证记录](research/phase2-validation.md)
13. [Phase 3 验证记录](research/phase3-validation.md)
14. [MVP 完成度审计](research/mvp-completion-audit.md)
15. [架构决策记录](ADR/README.md)

## 同步原则

- roadmap 描述“准备做什么、做到什么算完成”。
- architecture 描述“系统现在如何工作”。
- ADR 描述“关键方向为何如此决定”。
- research 描述“比较过什么、证据和未知项是什么”。

不要只修改代码而让架构文档继续描述旧行为；也不要提前把尚未实现的设计写成已经存在的能力。
