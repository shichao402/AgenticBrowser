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

- [x] 正常导航与加载事件
- [x] `did-fail-load`
- [ ] `unresponsive` / `responsive`
- [x] `render-process-gone`
- [x] renderer 崩溃后重建 `WebContentsView`
- [x] 重建后 Profile/session 保持
- [x] 主动页面心跳检测 renderer 事件循环阻塞与恢复
- [x] main process 被杀后 Watchdog 重启
- [x] 从持久化浏览器检查点恢复

## 注入与 frame

- [x] `document_start` 时机验证
- [x] top frame 注入
- [x] same-origin iframe
- [x] cross-origin iframe/OOPIF
- [x] renderer 重建后重新安装脚本

## 录制性能

- [x] `capturePage` 10 FPS
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
- session frame preload 注入探针
- 主动 renderer 心跳停顿探针
- `capturePage` 10 FPS 基准
- 原子持久化的浏览器 URL/Profile 检查点
- 应用外 Watchdog、main process heartbeat 与重启预算
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
- `npm run smoke:electron`：启动 BrowserShell/page，验证二者 WebContents ID 不同；远程页面无 Node `process`/`require`，配置为 sandbox/context isolation；强制崩溃 renderer 后 page ID 从 2 变为 3、generation 从 1 变为 2，命令正常退出。
- `npm audit --omit=dev`：生产依赖 0 个已知漏洞。
- 完整 dev dependency 审计仍有 8 个 moderate，来自 electron-builder 的构建期 `global-agent -> roarr -> sprintf-js` 链；当前上游最新版本没有无风险升级，必须在发布前重新审计，不能将该结论外推为生产运行时安全。

修复记录：

- npm 11 的 install-script allowlist 初次阻止了 Electron binary 安装；已在 `package.json#allowScripts` 精确允许 `electron@44.7.2`。
- session frame preload 不能直接使用 ESM 产物；实测会报告 `Cannot use import statement outside a module`。preload 构建已统一输出 CommonJS：`shell.cjs` 与 `strategy-bootstrap.cjs`。

### 2026-10-15：注入、故障、Profile 与录制探针

命令：

```bash
npm run smoke:electron
```

本地探针页面包含 top frame、同源 iframe、以 `localhost` 与 `127.0.0.1` 分离站点的跨域 iframe，以及一个主动断开响应的导航端点。结果：

- smoke 总结果 `passed: true`。
- top frame、同源 iframe、跨域 OOPIF 均在页面 inline script 执行时看到 preload marker，且两者记录的 `document.readyState` 都是 `loading`。
- 跨域 frame 使用不同 renderer process，证明覆盖了 OOPIF，而不只是同进程 iframe。
- renderer 强制崩溃并重建后，三个 frame 均再次看到 preload marker，preload error 为空。
- Named Profile Cookie 在重建前后均存在。
- 观察到 `created`、导航开始/完成、加载开始/完成、`did-fail-load`、`renderer-gone` 和 `recreated` 事件。
- 页面事件循环阻塞 2 秒时，250 ms 主动 ping 能检测停顿；阻塞结束后 ping 恢复。
- `capturePage` 采集 20 帧，无空帧；帧起始间隔折算 9.92 FPS，平均采集 27.10 ms，p95 35.38 ms，RSS 增量约 31.0 MiB。
- 随后的 `npm run check` 通过：类型检查、8 项单元测试、生产构建和生产依赖审计均成功；`git diff --check` 无错误。

`webContents` 的 `unresponsive` 事件继续保留为辅助信号，但它不适合作为后台监督主信号：触发延迟通常约 30 秒，并受用户输入与页面可见性影响。Phase 1 的 HealthMonitor 必须以短周期主动心跳和业务断言为主，`unresponsive`/`responsive` 只补充故障时间线。

当前 10 FPS 结果只证明单个可见 `WebContentsView` 的短时采集能力；尚未证明环形缓冲上限、长时间稳定性、多页面并发或交互延迟，因此这些验收项保持未完成。

### 2026-10-15：应用外 Watchdog 与持久化检查点

命令：

```bash
npm run smoke:watchdog
```

该探针由独立 Node Watchdog 进程启动 Electron，Electron main 每 500 ms 原子写 heartbeat。测试页面设置 Profile Cookie；BrowserSupervisor 将 Profile ID、当前 URL、原因和时间写入版本化 JSON 检查点。测试驱动等待首个子进程就绪后，从 Watchdog 外部强制终止 Electron main。

结果：

- 首次 Electron main PID 为 `93288`，Watchdog PID 为 `89700`；首次检查点与 Profile Cookie 均已建立。
- 强杀后 Watchdog 记录一次异常退出，在 250 ms backoff 后启动第二个 Electron main，PID 变为 `6424`。
- 第二个进程读取磁盘检查点并恢复到相同 URL，Profile Cookie 仍存在。
- Watchdog 最终状态为 `stopped`、`launches: 2`、`restartCount: 1`，子进程正常退出；总结果 `passed: true`。
- 检查点写入使用同目录临时文件加 rename；损坏 JSON 会被隔离为 `.corrupt-*`，避免启动崩溃循环。
- 新增检查点测试后，`npm test` 为 2 个测试文件、12 项测试通过。
- 原有 `npm run smoke:electron` 回归继续 `passed: true`，本轮采集达到 9.99 FPS。
- `npx electron-builder --win --dir` 重新打包成功；`app.asar` 已包含 `out/main/watchdog.js` 及其共享原子文件 chunk。

这证明了开发环境中的独立进程重启和最小浏览器状态恢复。当前检查点只包含 URL 与 Profile ID，不等同于 Phase 3 的 workflow 步骤、幂等键和业务记录。Watchdog 产物已经由构建生成，但安装包入口、开机启动和 macOS launchd/签名集成仍属于 Phase 1 与双平台发布验证，不能按已交付能力宣称。
