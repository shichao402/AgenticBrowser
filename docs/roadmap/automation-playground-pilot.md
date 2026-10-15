# 公开自动化测试站点验收试点

- Status: two-site Windows end-to-end gate passed
- Target phase: Phase 3
- Sites:
  - `https://www.selenium.dev/selenium/web/`
  - `https://testpages.eviltester.com/challenges/synchronization/dynamic-buttons-01/`
- Account required: no
- Remote business writes: no

## 为什么选择这些站点

知识星球试点需要用户账号登录，真实自动化可能触发平台风控。2026-10-15 按用户要求停止该试点，不再访问账号或生产数据。

第一站采用 Selenium 项目公开提供的浏览器测试资源。页面本身用于 WebDriver/浏览器回归，具备表单、动态 DOM、下载、frame、Shadow DOM 和慢资源等测试素材。第二站采用 Test Pages 的动态同步挑战；该站明确说明用于练习自动化与软件测试。两站均无需账号；Selenium 表单只以 GET 查询参数提交到公开测试回显页，不写入远端业务数据。曾考虑 `the-internet.herokuapp.com`，但当前 Windows 主机无法连接，因此不作为自动门禁依赖。

## 当前流程

BrowserShell 可安装一个默认禁用的 `selenium-automation-playground` Project：

1. 打开 `web-form.html`。
2. 填写无敏感测试标记、文本域、下拉框和复选框。
3. 通过 GET 提交到 `submitted-form.html`，验证 URL 参数和 `Received!`。
4. 打开 `dynamic.html`，点击两个控件并等待一秒后出现的方块和输入框。
5. 写入已显示的输入框，推进 workflow。
6. 打开 `downloads/download.html`。
7. 预授权并下载固定的 `file_1.txt`。
8. 校验 14-byte 文件及 SHA-256，再原子提交到 Project 目录。
9. 跨域打开 Test Pages 的动态按钮同步挑战。
10. 依次等待并点击 `start`、`One`、`Two`、`Three`，验证 `All Buttons Clicked`。

Strategy 只匹配上述 Selenium 资源和 Test Pages 的单个挑战路径，不拥有 `network.request`、`main-world`、弹窗、通知、地理位置、媒体、剪贴板或全屏权限。

## 自动化门禁

```text
npm run smoke:automation-playground
=> passed
```

门禁执行三个 Runtime：

1. 正常运行 Selenium 表单、延迟 DOM、下载，以及 Test Pages 四阶段延迟按钮流程。
2. 在 `wait-dynamic` 节点强制终止 renderer；BrowserSupervisor 重建 view，Strategy 重新注入并从同一节点完成。已下载文件命中幂等记录。
3. 从同域不存在页面启动，业务断言触发 `page-changed` 自动暂停；人工导航到表单页后恢复同一 Runtime 并完成。

最终证据：

- 三个 Runtime 均为 completed，每轮 scanned/matched/skipped 为 4/4/0。
- `records/items.json` 只有 form、dynamic、download、testpages-dynamic-buttons 四条记录，seen count 均为 3。
- `records/downloads.json` 只有一条 completed 记录。
- 文件为 `Hello, World!\n`，14 bytes，SHA-256 为 `c98c24b677eff44860afea6f493bbaec5bb1c4cbb209c6fc2bbb47f66ff2ad31`。
- 最终目录只有一个文件，`tmp/` 为空。
- renderer generation 增长，事件中包含 `renderer-gone`、`recovery-succeeded` 和 `recreated`。
- 页面变化暂停原因归类为 `page-changed`，paused/resumed 事件各一条。
- 每轮最终检查点均为 `playground.second-site.completed`，payload 为 `All Buttons Clicked` 和四个按钮。

## 结论边界

本试点证明跨两个真实 HTTPS 域名的确定性页面操作、跨页面 workflow、多阶段延迟 DOM、下载事务、幂等、renderer 恢复和人工接管可以协同工作。它不证明任意生产网站都兼容，也未覆盖：

- 登录、MFA、验证码与账号风控。
- 文件上传、系统文件选择器和客户端证书。
- 跨域 frame、Shadow DOM、Canvas 和 WebAuthn 的完整流程。
- 在真实公网文件下载过程中强杀进程；独立本地慢速下载门禁已经验证 Electron main 强杀后的安全重试。
- 真实公网断网、隔离卷 `ENOSPC` 和长时间资源预算；独立本地门禁已经验证 Electron session 离线与项目配额不足分类。
- macOS 打包、签名、公证和运行。
