# ADR-0002: 以 Project、Strategy、Profile 为核心模型

- Status: Accepted
- Date: 2026-10-15

## Context

用户既需要类似 Tampermonkey 的 URL 匹配脚本，也需要跨多个页面的完整业务编排、定时运行、多项目并发、独立登录状态和项目输出目录。

如果让单个脚本同时负责页面逻辑、跨页编排、调度和恢复，会导致多个脚本争夺流程控制权，难以实现幂等恢复和项目级监控。

## Decision

采用以下领域对象：

- **Strategy**：URL 匹配后的页面局部行为，包含版本、权限、配置、心跳、超时和完成信号。
- **Project**：用户启动、停止和监控的业务单元，包含策略 allowlist、初始化页面、workflow、Profile、配置、输出目录和运行模式。
- **Profile**：命名身份容器，映射到持久化 Electron session partition。
- **Project Runtime**：项目的一次活跃运行，保存页面、workflow 状态、检查点、资源预算和故障记录。

约束：

- URL 匹配只表示 Strategy 有资格运行；还必须被当前 Project 明确允许。
- Project 固定 Strategy 版本，升级需要显式确认。
- Project workflow 负责跨页面编排；Strategy 不直接拥有全局流程。
- Profile 默认每项目隔离，但用户可以显式让多个项目共享身份。
- 项目可配置为手动、自动启动、常驻监听或定时唤醒。
- Runtime Manager 执行全局并发和资源预算。

## Consequences

正面影响：

- Strategy 可以跨项目复用，同时保持项目权限和版本可控。
- 跨页面恢复具有显式状态和检查点。
- 多项目登录状态既可隔离，也能按需共享。
- 监控、调度和下载目录可以自然归属到 Project。

代价：

- 需要定义稳定的 manifest、版本和迁移机制。
- 共享 Profile 的项目仍可能通过 Cookie、存储或账号状态间接影响彼此。
- Strategy 与 workflow 的职责边界必须通过 API 和评审持续约束。

## Rejected alternatives

- 全局共享浏览器 Profile：隔离和故障归因不足。
- 每个脚本自行编排：无法可靠恢复跨页面流程。
- 所有项目强制独立身份：不能覆盖用户主动共享登录的场景。
