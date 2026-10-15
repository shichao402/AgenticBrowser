# Phase 1 验证记录

- Status: Windows implementation complete; macOS external gate pending
- Started: 2026-10-15
- Current host: Windows 10.0.26100

## 当前交付

- [x] 主进程主动 Page heartbeat
- [x] reload → 忽略缓存 reload → 清 cache 并 reload → 重建 view 的分级恢复
- [x] 时间窗重试预算、指数退避和熔断
- [x] 熔断后隐藏远程 view 并显示本地错误页
- [x] Capability Store 与 BrowserShell 能力中心
- [x] 默认拒绝网页权限
- [x] 弹窗默认阻断；显式允许后转入当前受控页面
- [x] session `will-download` 接管、目录约束和安全文件名
- [x] 下载允许/拒绝事件和汇总指标
- [x] Electron 进程 CPU/内存、页面健康、恢复和下载监控
- [x] JSONL 结构化浏览器事件日志
- [x] 多 tab 创建、切换、关闭与 session handler 转移
- [x] Profile 创建、激活、删除 UI、命名 session 隔离与删除清理
- [x] Profile 删除的 Project 引用保护（由 Phase 3 Project Store 补齐）
- [x] 默认策略 + 精确 HTTP(S) Origin 的能力规则
- [x] 下载元数据、哈希、临时目录和原子完成（由 Phase 3 Download Manager 补齐）
- [x] 打包应用 Watchdog launcher、重复启动锁、登录启动 API/UI 与 packaged 能力探针（Windows；实际写入及重启自启 E2E 待补）

## 2026-10-15：监督恢复、能力和下载故障探针

命令：

```bash
npm run smoke:recovery
```

本地受控站点依次执行：

1. 默认配置调用 `window.open`，确认弹窗被阻断。
2. 通过 BrowserShell IPC 创建并激活新 Profile，确认默认 Profile 的标记 Cookie 不可见；切回默认 Profile 后确认 Cookie 恢复，再删除非活动 Profile。
3. 创建第二个 tab 并关闭持有 session download handler 的首 tab，确认 handler 转移后第二个 tab 继续受控。
4. 对当前精确 Origin 覆盖 popup 与 geolocation；确认 Chromium 权限状态从 `denied` 变为 `granted`，弹窗 URL 被转入当前 `WebContentsView`。
5. 下载 4,096 bytes 的模拟 MP3，确认 `will-download` 写入受控临时测试目录，原始名称中的 Windows 非法字符被清理。
6. 对同一 Origin 显式拒绝 geolocation 与 download；确认权限状态回到 `denied`，再次下载被阻断；再关闭持有 permission handler 的最新 tab，确认 handler 转移后拒绝规则仍生效。
7. 导航到持续主动断开连接的端点，观察完整恢复和熔断。

结果 `passed: true`：

- 弹窗阻断与显式路由均有结构化事件。
- BrowserShell IPC 持久化完整 Capability Policy；精确 Origin 覆盖同时约束 Chromium 权限、弹窗和下载，默认值没有被覆盖规则改写。
- 关闭注册 session permission handler 的 tab 后，handler 转移到剩余 tab，拒绝规则仍生效；已关闭 tab 不再发布迟到的健康或加载事件。
- Profile 创建、激活、切回和删除均通过真实 preload/IPC 链路；不同命名 session 的 Cookie 隔离，切回原 Profile 后状态仍在，删除后目标 session Cookie 已清空。
- 创建两个独立 WebContents tab 后可切换/关闭；首 tab 关闭后 session handler 成功转移，后续下载仍只处理一次。
- 允许的下载完成 1 个、4,096 bytes；禁止后的下载产生 `download-blocked`。
- 持续加载失败依次执行 `reload`、`reload-ignore-cache`、`clear-cache-and-reload`、`recreate-view`。
- 四次恢复失败后，第 5 次决策在约 3.96 秒时打开 circuit，未继续无限刷新。
- view generation 从 1 变为 2；熔断快照为 `responsive: false`、`attemptsInWindow: 4`。
- 自动化下载目录在测试结束时清理。

单元验证：

- `RecoveryPolicy`：动作升级、最低恢复级别、时间窗过期、手工 reset、backoff 上限。
- `HealthMonitor`：连续失败阈值、一次性告警、恢复和 probe timeout。
- `CapabilityStore`：旧平面配置迁移、完整默认策略、规范 Origin、精确匹配、覆盖继承、未知字段和错误 schema 拒绝。
- 下载文件名：路径分隔符、Windows 非法字符、设备保留名、空名和长度上限。
- `StructuredEventLog`：并发 append 后仍保持有序、完整 JSONL。
- `ProfileStore`：默认状态、创建/激活/删除保护、损坏文件回退和并发写入串行化。

该阶段当时共 10 个测试文件、38 项测试通过；最新总数见 [Phase 3 验证](phase3-validation.md)。

## 2026-10-15：打包应用 Watchdog 入口

命令：

```bash
npm run smoke:watchdog
npm run smoke:watchdog:packaged
```

结果：

- 源码 Watchdog 仍能在强杀 Electron main 后启动新 PID，并恢复 URL、Profile Cookie 和浏览器检查点；退出后进程锁已清理。
- `electron-builder --dir` 生成的 Windows `AgenticBrowser.exe` 不再直接承载正式 main：初始进程成功委托 app.asar 内的 Watchdog 后退出，Watchdog 再启动带 heartbeat 的受管 Electron。
- 最新 NSIS one-click 安装包以 silent 模式安装到隔离目录；从安装目录运行同一强杀/恢复探针也为 `passed: true`，随后 silent 卸载成功。
- 打包探针首次 Watchdog PID 为独立进程；强杀首个受管 Electron 后，第二个 Electron PID 恢复相同 URL、Cookie 和检查点，总结果 `passed: true`。
- 安装后的受管子进程确认 `startupSettings.supported: true`、`managedByWatchdog: true`、`openAtLogin: false`。测试只读取登录项能力，没有擅自修改当前用户的系统登录启动设置。
- 在首个 Runtime 存活时再次启动打包 exe，第二个 Watchdog 被锁拒绝，没有覆盖首个 heartbeat/state，也没有创建第二个 Electron Runtime。
- launcher 单元测试确认只转发受控 smoke 标记，不把任意命令行参数带入高权限子进程。

## 证据边界

- popup capability 当前采用“阻断网站新窗口并将 URL 转入当前受控 tab”；产品 tab 由 BrowserShell 显式创建，网站不能绕过策略自行增加 tab。
- Phase 1 的基础 Download Manager 只负责 session 接管；Phase 3 已在其上补齐业务幂等键、临时文件事务、哈希、磁盘配额和下载 manifest，证据见 [Phase 3 验证](phase3-validation.md)。
- Phase 1 首先实现应用级 origin + permission；Phase 3 已把同一策略结构纳入 Project 快照，形成 Project + origin + permission 授权模型。
- Profile 切换会销毁当前 tab 集合，在新命名 session 中以最近活动 URL 创建首个 tab；切回后 Cookie/session 数据保留，但完整 tab 集合恢复属于 Phase 3。
- 当前禁止删除默认、活动或被 Project 引用的 Profile；Profile 共享仍必须由 Project 显式声明。
- Windows 打包 Watchdog 与重复启动锁已验证；登录启动已实现 API/UI，packaged smoke 只读验证了能力状态，尚未修改系统登录项或执行重启自启 E2E。macOS 的 login item、DMG、签名、公证和实际启动必须在 macOS 环境闭合。
- 浏览器检查点仍只保存最近激活 tab 的 URL/Profile，不保存完整 tab 集合；Phase 3 另行持久化 Project Runtime/workflow 检查点，但不承诺恢复任意 tab 集合。
- 进程 CPU/工作集来自 Electron `app.getAppMetrics()`；无法可靠归属到单个 Strategy 的共享消耗没有伪造拆分。
