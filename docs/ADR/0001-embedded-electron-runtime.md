# ADR-0001: 使用 Electron 内嵌 Chromium

- Status: Accepted
- Date: 2026-10-15

## Context

产品需要：

- Windows/macOS 独立客户端和单窗口内嵌网页。
- 类似 Tampermonkey 的按 URL 注入。
- 监听加载失败、无响应和 renderer 崩溃。
- reload、清缓存、销毁并重建页面。
- 自有地址栏、权限、下载、监控和 Agent 面板。
- 在页面脚本已经失效时仍能由页面外监督者恢复。

曾比较以下路线：

1. 外部官方 Google Chrome + CDP。
2. Electron 内嵌 Chromium。
3. CEF。
4. 自维护 Chromium fork。

官方 Chrome 提供最真实的 Chrome 产品特征，但不能以受支持方式嵌入自有跨平台窗口；浏览器 UI 和系统对话框需要脆弱的 OS 自动化。CEF 和 Chromium fork 可以提供更深控制，但显著提高双平台原生开发、安全补丁和发布维护成本。

## Decision

第一版使用 Electron、TypeScript、React 和 `WebContentsView` 内嵌目标网页。

- 产品追求目标站点功能兼容，不宣称与官方 Google Chrome 不可区分。
- 远程网页启用 sandbox、context isolation，并禁用 Node integration。
- BrowserShell UI 与远程网页使用不同 renderer。
- userscript、页面探针和自动化工具由应用管理，不依赖 Chrome 扩展。
- 用独立轻量 Watchdog 覆盖 Electron main/browser process 整体崩溃。

## Consequences

正面影响：

- 页面、浏览器外壳和自动化生命周期位于同一个产品控制边界。
- 可直接使用 Electron 页面、session、权限、下载和子进程事件。
- 不需要通过坐标和焦点控制外部 Chrome。
- TypeScript/Node 生态便于接入 CodeBuddy SDK 和结构化工具。

代价：

- Widevine、Chrome Sync、Google 浏览器私有 API和完整 Chrome 扩展生态不在默认能力内。
- 某些 WebAuthn、证书、媒体和系统权限流程需要逐平台验证。
- 必须持续升级 Electron/Chromium，及时获取安全补丁。
- Electron 整体崩溃仍需要应用外 Watchdog。

## Rejected alternatives

- 外部官方 Chrome：无法满足强嵌入和完整 BrowserShell 控制。
- CEF：当前收益不足以覆盖 C++ 多进程、沙箱和发布复杂度。
- Chromium fork：个人项目无法合理承担长期浏览器内核维护。
