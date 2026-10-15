# Phase 0 验证记录

- Status: In progress
- Started: 2026-10-15
- Current host: Windows 10.0.26100

本文件记录 Phase 0 的可复现证据。没有运行证据的项目保持未完成。

## 工程基线

- [x] `npm run typecheck`
- [x] `npm test`
- [x] `npm run build`
- [x] Windows 开发模式启动
- [x] Windows unpacked 应用构建和启动
- [x] Windows NSIS 安装包构建
- [ ] Windows 安装后启动
- [ ] macOS 构建、签名和启动

## 安全隔离

- [x] 远程页面 `nodeIntegration: false`
- [x] 远程页面 `contextIsolation: true`
- [x] 远程页面 `sandbox: true`
- [x] BrowserShell 与远程页面使用不同 `WebContents`
- [ ] 非 BrowserShell sender 无法调用高权限 IPC
- [x] 导航只允许 HTTP/HTTPS

## 生命周期与恢复

- [ ] 正常导航与加载事件
- [ ] `did-fail-load`
- [ ] `unresponsive` / `responsive`
- [x] `render-process-gone`
- [x] renderer 崩溃后重建 `WebContentsView`
- [ ] 重建后 Profile/session 保持
- [ ] main process 被杀后 Watchdog 重启
- [ ] 从持久化检查点恢复

## 注入与 frame

- [ ] `document_start` 之前/时机验证
- [ ] top frame 注入
- [ ] same-origin iframe
- [ ] cross-origin iframe/OOPIF
- [ ] renderer 重建后重新安装脚本

## 录制性能

- [ ] `capturePage` 10 FPS
- [ ] 环形缓冲内存上限
- [ ] 页面交互延迟影响
- [ ] 多 `WebContentsView` 影响
- [ ] renderer 挂死时的证据兜底

## 目标站点

- [ ] 目标站点 A：知识星球基础登录与首页
- [ ] 目标站点 B：待确定

## 当前实现切片

正在建立：

- `BaseWindow + BrowserShell WebContentsView + remote WebContentsView`
- Named Profile session 基础
- 导航、普通刷新和忽略缓存刷新
- 生命周期事件流
- renderer 崩溃后页面重建入口
- URL 安全校验与单元测试

每次勾选项目时，在下方追加命令、环境、版本和观察结果。

## 运行证据

### 2026-10-15：工程基线

环境：

- Windows 10.0.26100
- Node.js 26.5.0
- Electron 44.7.2
- electron-vite 6.0.0
- Vite 8.3.4
- React 19.3.1

结果：

- `npm run typecheck`：通过。
- `npm test`：1 个测试文件、8 项测试通过。
- `npm run build`：main、preload、renderer 全部构建成功。
- `npm run dev`：Electron 成功启动，观察到 5 个 browser/renderer/GPU/utility 进程均为 responding。
- `npx electron-builder --win --dir`：生成 `release/win-unpacked`；`AgenticBrowser.exe` 启动后主窗口标题正确且 responding。
- `npx electron-builder --win`：成功生成 x64 NSIS 安装包和 block map。尚未在本机执行安装流程。
- `npm run smoke:electron`：隐藏模式启动 BrowserShell/page，验证二者 WebContents ID 不同；远程页面无 Node `process`/`require`，配置为 sandbox/context isolation；强制崩溃 renderer 后 page ID 从 2 变为 3、generation 从 1 变为 2，命令正常退出。
- `npm audit --omit=dev`：生产依赖 0 个已知漏洞。
- 完整 dev dependency 审计仍有 8 个 moderate，来自 electron-builder 的构建期 `global-agent -> roarr -> sprintf-js` 链；当前上游最新版本没有无风险升级，必须在发布前重新审计，不能将该结论外推为生产运行时安全。

修复记录：

- npm 11 的 install-script allowlist 初次阻止了 Electron binary 安装；已在 `package.json#allowScripts` 精确允许 `electron@44.7.2`。
- ESM preload 构建产物为 `out/preload/index.mjs`，主进程路径已与产物对齐。
