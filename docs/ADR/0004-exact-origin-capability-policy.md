# ADR-0004: 使用精确 Origin 的能力策略

- Status: Accepted
- Date: 2026-10-15

## Context

全应用布尔开关无法表达“只允许目标站点使用摄像头、弹窗或下载”，也会让一个站点的授权意外扩大到同一 Profile 中打开的其他页面。浏览器权限检查、弹窗和下载提供的来源字段不同，需要统一到同一个可审计决策。

## Decision

- Capability Policy schema v1 由完整的默认策略和零到多个 Origin 覆盖组成。
- Origin 只接受规范化后的精确 HTTP(S) Origin；不支持通配符，也不让子域隐式继承。
- Chromium 权限使用 Electron 提供的 requesting/security origin；弹窗使用 opener 页面 Origin；下载使用发起下载的 WebContents Origin。
- 非 HTTP(S)、不透明 Origin、未知权限和无法确定来源的请求一律拒绝。
- 远程页面不能读取或修改策略；只有本地 BrowserShell 可经受信 IPC 更新完整策略。
- 旧版平面布尔配置读取时迁移为默认策略，保留用户选择。
- Phase 1 先持久化一个运行上下文策略；Phase 3 将同一策略结构归入 Project 配置，并由 Project Runtime 提供当前策略。

## Consequences

- 用户可以分别配置默认值与当前站点覆盖，授权边界可解释且可测试。
- CDN 或跨域 iframe 不会自动获得顶层站点的权限，需要自己的精确 Origin 规则。
- 站点更换协议、端口或子域时需要新增规则。
- Project 模型落地前，多个尚未归属 Project 的浏览器页面仍共享同一份策略文件。

## Rejected alternatives

- 只按当前 tab URL 使用全局开关：跨域 iframe 和后台请求的来源判断错误。
- 域名后缀或通配符匹配：授权范围容易被同名子域扩大。
- 直接采用 Chromium 的持久权限提示：无法与 Project 配置、审计和自动化恢复形成统一策略。
