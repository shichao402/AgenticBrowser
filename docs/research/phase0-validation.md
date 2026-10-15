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
- [x] Windows 安装后启动
- [ ] macOS 构建、签名和启动

## 安全隔离

- [x] 远程页面 `nodeIntegration: false`
- [x] 远程页面 `contextIsolation: true`
- [x] 远程页面 `sandbox: true`
- [x] BrowserShell 与远程页面使用不同 `WebContents`
- [x] 非 BrowserShell sender 无法调用高权限 IPC
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
- [x] 环形缓冲内存上限
- [x] 页面交互延迟影响
- [x] 多 `WebContentsView` 影响
- [x] renderer 挂死时的证据兜底

## 目标站点

- [x] 目标站点 A：Selenium 官方公开测试页面（表单、动态 DOM、下载与恢复）
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
- 远程页面 main world 不存在 Node `process`、`require` 或 BrowserShell 的 `agenticBrowser` IPC bridge。
- 跨域 frame 使用不同 renderer process，证明覆盖了 OOPIF，而不只是同进程 iframe。
- renderer 强制崩溃并重建后，三个 frame 均再次看到 preload marker，preload error 为空。
- Named Profile Cookie 在重建前后均存在。
- 观察到 `created`、导航开始/完成、加载开始/完成、`did-fail-load`、`renderer-gone` 和 `recreated` 事件。
- 页面事件循环阻塞 2 秒时，250 ms 主动 ping 能检测停顿；阻塞结束后 ping 恢复。
- `capturePage` 采集 20 帧，无空帧；帧起始间隔折算 9.92 FPS，平均采集 27.10 ms，p95 35.38 ms，RSS 增量约 31.0 MiB。
- 随后的 `npm run check` 通过：类型检查、8 项单元测试、生产构建和生产依赖审计均成功；`git diff --check` 无错误。

`webContents` 的 `unresponsive` 事件继续保留为辅助信号，但它不适合作为后台监督主信号：触发延迟通常约 30 秒，并受用户输入与页面可见性影响。Phase 1 的 HealthMonitor 必须以短周期主动心跳和业务断言为主，`unresponsive`/`responsive` 只补充故障时间线。

该次结果只证明单个可见 `WebContentsView` 的短时采集能力；环形缓冲、多页面和交互影响随后由扩展探针验证，长时间稳定性仍不在当前证据范围内。

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

这证明了开发环境中的独立进程重启和最小浏览器状态恢复。当前检查点只包含 URL 与 Profile ID，不等同于 Phase 3 的 workflow 步骤、幂等键和业务记录。后续 Phase 1 已补齐 Windows 打包应用入口与登录启动开关，证据记录在 [Phase 1 验证](phase1-validation.md)；macOS 集成仍不能按已验证能力宣称。

### 2026-10-15：环形缓冲、交互影响、多页面与挂死证据

扩展后的 `npm run smoke:electron` 结果仍为 `passed: true`：

- 单页面 20 帧为 9.97 FPS，平均采集 17.84 ms、p95 27.13 ms，0 空帧。
- 环形缓冲硬限制为 10 帧/1 MiB；输入 20 帧后保留最新 10 帧、237,200 bytes，淘汰 10 帧，没有越过上限。
- 无录制时 renderer 往返延迟 p95 为 1.00 ms；10 FPS 录制期间 p95 为 1.06 ms，增加 0.06 ms。
- 两个同时可见且具有不同 WebContents ID 的页面保持运行；辅助页面的 50 ms tick 在测试期间持续前进。第二页面负载存在时，主页面 20 帧采集达到 9.97 FPS，p95 18.96 ms，全部非空。该结果验证“活动页面录制 + 另一活动页面”的影响，不外推为所有页面同时录制。
- renderer JavaScript 事件循环阻塞期间，主进程在 29.06 ms 内仍取得 23,720 bytes 的合成器画面；同时冻结的故障前环形缓冲保留 3 帧、71,160 bytes。即使实时截图失败，冻结缓冲也不依赖页面脚本存活。
- `CaptureRingBuffer` 对帧数、字节数、超大帧和冻结行为有单元测试；当前总计 3 个测试文件、15 项测试通过。
- Windows 上 `capturePage` 在窗口没有可用显示合成表面时会报告 `Current display surface not available for capture`/`UnknownVizError`。Smoke 明确前置并聚焦测试窗口后稳定通过；正式 Recorder 必须把页面可见性作为运行前置条件，并将该错误分类为“当前不可录制”，不能无限重试。

这些数据是当前 Windows 主机上的短时 Phase 0 基准，不代表所有硬件的长期容量结论。Phase 4 仍需实现变化抽帧、磁盘证据包、保留期限和长时间压力测试。

### 2026-10-15：Windows 安装后启动

- `npm run dist` 使用当前源码重新生成 x64 NSIS one-click 安装包和 block map。
- 安装包以 silent 模式安装到独立测试目录，退出码为 0。
- 从安装目录启动 `AgenticBrowser.exe` 后，进程 `Responding: True`，主窗口标题为 `AgenticBrowser`，实际进程路径指向安装目录而非 unpacked 构建。
- 测试结束后关闭应用并运行安装目录内的 uninstaller，退出码为 0。

本次验证使用默认 Electron 图标和未配置发布证书的开发构建；正式图标、代码签名、SmartScreen、升级和回滚仍是发布前工作。

### 2026-10-15：首个公开真实站点

Selenium 官方测试资源 `https://www.selenium.dev/selenium/web/` 已通过 Electron 真实网络闭环：表单提交、延迟 DOM、固定文件下载、renderer 崩溃重建，以及页面漂移后的暂停/人工恢复均成功。该站点无需账号且不写入远程业务数据。详细过程、哈希和结论边界见 [Phase 3 验证](phase3-validation.md) 与 [Selenium 自动化验收试点](../roadmap/automation-playground-pilot.md)。

## 当前主机无法闭合的 Phase 0 项

- 当前只有 Windows 主机，不能把 Windows 交叉产物当作 macOS 构建、签名、公证或启动证据；需要 macOS runner 或真实设备。
- 第二个公开真实目标站点尚未确定；`the-internet.herokuapp.com` 在当前主机不可达，不作为门禁依赖。
- Chromium `unresponsive`/`responsive` 事件本身没有可靠、可配置的短超时触发方式；后台监督已经改用主动 heartbeat，原生事件只保留辅助观测，不伪造完成证据。
