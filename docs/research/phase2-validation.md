# Phase 2 验证记录

- Status: In progress
- Started: 2026-10-15
- Current host: Windows 10.0.26100

## 当前交付

- [x] Strategy manifest schema v1 与共享类型
- [x] 严格字段、权限、SemVer、JSON 配置、超时和源码大小校验
- [x] HTTP(S) scheme/host/subdomain/port/path match pattern
- [x] match、exclude、top/all frame scope
- [x] `enabled + Project allowlist + URL` 三重选择边界
- [x] 版本化 Strategy 注册表、串行原子更新和损坏文件隔离
- [ ] 隔离 world 执行器和受控 main-world bridge
- [ ] run-at/frame/OOPIF 生命周期
- [ ] 配置、日志、领域事件与安全网络请求 API
- [ ] 启动超时、心跳、故障归因与 renderer 重建恢复
- [ ] 保存后热重载和 Strategy 编辑/启停 UI

## 2026-10-15：manifest、匹配与存储

验证命令：

```bash
npm run typecheck
npm test
git diff --check
```

结果：

- Node 与 Web TypeScript 工程均通过严格类型检查。
- 12 个测试文件、50 项测试通过。
- Strategy matcher 覆盖精确主机、子域、scheme/port wildcard、默认端口、path/query、exclude、frame scope、allowlist 和非 Web URL 安全失败。
- Strategy Store 覆盖空状态、排序、并发写入、启停、删除、未知字段/权限、重复 pattern、非法 JSON 配置和损坏文件隔离。
- 差异检查无空白错误。

## 安全与能力边界

- `<all_urls>` 仅表示 HTTP/HTTPS，不包含 `file:`、`data:`、`javascript:` 或其他协议。
- Project 尚未实现；当前 matcher 接收调用方传入的显式 allowlist，执行器不得自行绕过。
- manifest 的 DOM 权限目前是声明与审计信息。任意页面脚本一旦执行便无法靠该声明可靠细分 DOM 读写；网络、文件、领域事件等宿主能力必须在可信边界强制校验。
- IPv6 host pattern 当前不支持；若真实目标站点需要，必须先补解析与回归测试。
- 本记录不证明 Strategy 已经能够执行，执行生命周期与恢复门禁仍未完成。
