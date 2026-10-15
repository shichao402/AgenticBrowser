# 浏览器内核与兼容性研究

- Date: 2026-10-15
- Outcome: 由 [ADR-0001](../ADR/0001-embedded-electron-runtime.md) 固化为 Electron 路线。

## 比较过的路线

### 外部官方 Google Chrome

优点：

- 网页确实运行在官方 Chrome 中。
- Google 品牌组件、Widevine、官方媒体构建和 Chrome 产品行为最完整。
- Chrome 自己承担内核安全更新。

缺点：

- 没有受支持的 Windows/macOS 跨平台嵌入接口。
- 产品只能采用“控制器窗口 + 独立 Chrome 窗口”。
- 地址栏、权限气泡和系统文件框需要 Windows UI Automation 或 macOS Accessibility 等外部控制。
- Chrome 自动更新会改变 CDP 行为。
- Chrome 136 起 remote debugging 需要非默认 profile；品牌版 Chrome 对扩展侧载也持续收紧。

结论：适合把“官方 Chrome 身份”置于最高优先级的产品，不适合本产品要求的强嵌入和 BrowserShell 控制。

### Electron

优点：

- 直接内嵌 Chromium 页面并自定义完整窗口。
- 提供加载失败、无响应、renderer 消失、session、权限、下载和缓存 API。
- TypeScript/Node 技术栈适合快速验证和 Agent SDK sidecar。
- Windows/macOS 打包、签名和更新工具成熟。

缺点：

- 不是官方 Google Chrome，网页可以识别 Electron 差异。
- 不自动继承 Chrome Sync、Google 私有服务、Widevine 和完整扩展生态。
- Electron main process 整体崩溃需要外部 Watchdog。

结论：最符合“内嵌、完整控制、个人项目可维护”的优先级。

### CEF

优点：

- 原生层控制深入，适合 C++ 多进程集成和定制浏览器产品。

缺点：

- 双平台 C++、沙箱、helper 签名、公证和更新复杂度更高。
- 仍不是官方 Google Chrome。
- 当前需求中的页面和恢复控制并未超过 Electron 能力上限。

结论：只有 Electron 的能力被真实站点验证为不足时再重新评估。

### Chromium fork

优点：

- 可以修改浏览器进程、renderer、扩展和恢复逻辑，控制能力最高。

缺点：

- 需要持续跟进 Chromium 安全更新、双平台构建、测试、符号、安装器和组件许可。
- Google Chrome 品牌资源、签名、官方 API Key 和闭源组件仍不能合法复制。

结论：不适合个人产品。

## Chromium 与 Google Chrome 的边界

Chromium 是开源主体；Google Chrome 是由 Google 构建、测试、签名和分发的产品。后者还包含或依赖：

- 内部品牌资源。
- 官方 Google API Key 和受限浏览器服务。
- Widevine CDM 与相关签名/许可。
- Google 发布、组件更新和灰度实验链路。

修改 User-Agent 只能改变部分表面信息，不能复制所有媒体、网络、GPU、服务和更新行为。本项目因此采用自有品牌并承诺功能兼容，不承诺不可区分。

## Electron 的预期兼容范围

通常可直接支持：

- OAuth、OIDC、SAML 网页 SSO。
- Cookie/session 登录。
- WebRTC、摄像头、麦克风和网页屏幕共享。
- Basic Auth、NTLM/Negotiate。
- 客户端 TLS 证书选择。
- 标准 HTML5 音视频。

可支持但需要平台验证：

- WebAuthn、Passkey、Touch ID、Windows Hello。
- 硬件安全密钥。
- 系统代理、证书库和系统音频捕获。
- SSO 与企业环境中的操作系统集成。

明确不作为 MVP 目标：

- Widevine DRM。
- Chrome Sync 与 Chrome 账号/书签/历史同步。
- Google 浏览器级私有 API。
- 完整 Chrome 扩展生态。

普通 Google 搜索、Gmail、Docs 等网页按标准网站访问，不依赖 Chrome 浏览器私有 API。

## OS 自动化结论

OS 自动化是从应用外操作另一个程序：

- Windows UI Automation、窗口 API、`SendInput`。
- macOS Accessibility、`CGEvent`。

它受到焦点、坐标、DPI、语言、窗口布局和系统授权影响。采用 Electron 后，地址栏、权限、下载、页面和项目 UI 都属于本应用，正常流程不使用坐标式 OS 自动化。

原生系统能力只保留为：

- renderer 挂死时的窗口画面捕获兜底。
- 无法绕过的系统授权窗口，由人完成确认。

## Phase 0 必须验证

- 两个真实目标站点。
- `document_start` 注入和 OOPIF/跨域 frame。
- SSO、WebRTC、上传下载、弹窗和持久会话。
- renderer 无响应/崩溃与 `WebContentsView` 重建。
- Electron main process 被杀后的 Watchdog 恢复。
- Windows/macOS 安装、签名与权限体验。
