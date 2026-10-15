# 架构决策记录

| 编号 | 状态 | 决策 |
| --- | --- | --- |
| [0001](0001-embedded-electron-runtime.md) | Accepted | 使用 Electron 内嵌 Chromium |
| [0002](0002-project-strategy-profile-model.md) | Accepted | 以 Project、Strategy、Profile 为核心模型 |
| [0003](0003-deterministic-recovery-before-agent.md) | Accepted | 确定性恢复优先，Agent 作为受限升级路径 |
| [0004](0004-exact-origin-capability-policy.md) | Accepted | 使用默认策略与精确 Origin 覆盖控制页面能力 |

## 模板

```markdown
# ADR-NNNN: 标题

- Status: Proposed
- Date: YYYY-MM-DD

## Context

## Decision

## Consequences

## Rejected alternatives
```

已接受 ADR 用新 ADR 替代，不删除历史。
