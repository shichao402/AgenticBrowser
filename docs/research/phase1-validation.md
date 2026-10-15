# Phase 1 验证记录

- Status: In progress
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
- [ ] Profile 管理 UI 与删除/引用保护
- [ ] 按站点细分的权限规则
- [ ] 下载元数据、哈希、临时目录和原子完成
- [ ] 安装包 Watchdog launcher 与开机启动

## 2026-10-15：监督恢复、能力和下载故障探针

命令：

```bash
npm run smoke:recovery
```

本地受控站点依次执行：

1. 默认配置调用 `window.open`，确认弹窗被阻断。
2. 创建第二个 tab 并关闭持有 session download handler 的首 tab，确认 handler 转移后第二个 tab 继续受控。
3. 开启 popup capability，再次调用并确认 URL 被转入当前 `WebContentsView`，没有创建产品控制外窗口。
4. 下载 4,096 bytes 的模拟 MP3，确认 `will-download` 写入受控临时测试目录，原始名称中的 Windows 非法字符被清理。
5. 关闭 download capability，再次下载并确认被阻断。
6. 导航到持续主动断开连接的端点，观察完整恢复和熔断。

结果 `passed: true`：

- 弹窗阻断与显式路由均有结构化事件。
- 创建两个独立 WebContents tab 后可切换/关闭；首 tab 关闭后 session handler 成功转移，后续下载仍只处理一次。
- 允许的下载完成 1 个、4,096 bytes；禁止后的下载产生 `download-blocked`。
- 持续加载失败依次执行 `reload`、`reload-ignore-cache`、`clear-cache-and-reload`、`recreate-view`。
- 四次恢复失败后，第 5 次决策在约 3.96 秒时打开 circuit，未继续无限刷新。
- view generation 从 1 变为 2；熔断快照为 `responsive: false`、`attemptsInWindow: 4`。
- 自动化下载目录在测试结束时清理。

单元验证：

- `RecoveryPolicy`：动作升级、最低恢复级别、时间窗过期、手工 reset、backoff 上限。
- `HealthMonitor`：连续失败阈值、一次性告警、恢复和 probe timeout。
- `CapabilityStore`：默认值、完整布尔 schema 与持久化。
- 下载文件名：路径分隔符、Windows 非法字符、设备保留名、空名和长度上限。
- `StructuredEventLog`：并发 append 后仍保持有序、完整 JSONL。

当前共 8 个测试文件、28 项测试通过。

## 证据边界

- popup capability 当前采用“阻断网站新窗口并将 URL 转入当前受控 tab”；产品 tab 由 BrowserShell 显式创建，网站不能绕过策略自行增加 tab。
- 当前 Download Manager 是 Phase 1 接管切片，还没有 Phase 3 所需的业务幂等键、临时文件事务、哈希、磁盘配额和下载 manifest。
- Capability 当前是应用级配置，不是最终的 Project + origin + permission 授权模型。
- 浏览器检查点只保存最近激活 tab 的 URL/Profile，不保存完整 tab 集合；完整 Runtime 恢复属于 Phase 3。
- 进程 CPU/工作集来自 Electron `app.getAppMetrics()`；无法可靠归属到单个 Strategy 的共享消耗没有伪造拆分。
