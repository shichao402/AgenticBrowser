# 贡献与文档同步

AgenticBrowser 采用文档随实现同步演进的方式开发。

## 变更要求

提交代码前，根据变更类型同步更新：

- 改变关键技术选型、边界或不可逆约束：新增或更新 `docs/ADR/`。
- 改变组件职责、数据流、权限或恢复流程：更新 `docs/architecture/`。
- 得到新的兼容性、性能或方案比较结论：更新 `docs/research/`。
- 改变范围、里程碑、验收条件或完成状态：更新 `docs/roadmap/`。
- 改变用户可见能力：更新根目录 `README.md`。

一个功能只有在实现、测试、相关文档和 roadmap 状态一致时才算完成。

## ADR 规则

- 使用四位递增编号，例如 `0004-example.md`。
- 状态使用 `Proposed`、`Accepted`、`Superseded` 或 `Deprecated`。
- 已接受 ADR 不直接改写历史结论；方向变化时新增 ADR，并在旧 ADR 中标记替代关系。

## 安全底线

- 远程网页必须运行在 sandbox 中，禁止 Node 集成。
- Agent、策略和远程页面不得直接获得 shell、原始 IPC、密钥或任意文件系统访问。
- 下载、上传和项目文件访问必须限制在显式授权的项目目录中。
- 恢复动作必须有预算和熔断，不能无限刷新或重复产生业务副作用。
- 任何密钥只放在系统钥匙串或本机私密配置，不提交到仓库。

## 开发顺序

1. 先补充或确认对应 ADR/架构设计。
2. 实现最小垂直切片。
3. 加入故障注入和回归验证。
4. 更新 roadmap 状态和验收记录。

## 验证门禁

- Pull Request 与 `main` push 的 CI 在 `windows-latest` 和 `macos-latest` 上分别执行 `npm ci` 和 `npm run check`。
- `npm run check` 覆盖版本一致性、Prettier 格式检查、ESLint、类型检查、Vitest、生产构建和生产依赖审计，不包含 Electron smoke。
- 改动浏览器生命周期、Strategy、Project、下载、Watchdog 或打包入口时，必须额外运行 README 中对应的 smoke，并在验证文档记录结果。

## 代码风格

- 统一由 Prettier 格式化，配置见 `prettier.config.js`，提交前执行 `npm run format`。
- 静态检查由 ESLint 承担，配置见 `eslint.config.js`，提交前执行 `npm run lint`。
- 确需违反某条规则时，使用带说明的行内豁免注释，并解释为什么该规则在此处不适用；不要放宽全局规则来绕过单个位置。
