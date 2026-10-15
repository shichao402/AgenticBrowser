# 知识星球文本与 MP3 采集试点

- Status: configurable pilot and local end-to-end gate implemented; authenticated real-site pilot pending
- Target phase: Phase 3

## 用户目标

用户打开 AgenticBrowser 后，项目复用已有登录状态，监听或定时扫描知识星球首页，筛选指定类型文本，进入匹配内容并点击下载其中的 MP3，将文件放入项目指定目录。

Project/Profile/Strategy/workflow、帖子记录、下载事务、幂等和登录接管的本地模拟闭环已经具备；真实知识星球认证后 Feed DOM、用户分类规则和真实 MP3 尚未验证，不能视为试点完成。

2026-10-15 已确认官方网页入口为 `https://wx.zsxq.com/dweb`，未登录时会跳转到 `https://wx.zsxq.com/login`。页面可识别“登录知识星球”“获取登录二维码”和手机号登录入口，但尚未使用用户 Profile 完成认证后的 Feed 结构采样。

## 当前实现

BrowserShell 的 Project 面板可显式安装一个默认禁用的知识星球模板。模板绑定当前 Profile，输出目录默认为系统下载目录下的 `AgenticBrowser/knowledge-planet`；用户必须先配置关键词、正则或 selector，并手工启用 Project，不会因安装而自动运行。

`knowledge-planet-collector` Strategy 当前支持：

- 可配置 `matches`、包含/排除关键词、正则和最多扫描项数。
- 可配置帖子、文本、MP3、详情链接和业务 ID selector。
- 把每个帖子按 matched/skipped 写入 `records/items.json`，按 Project + 业务 ID 跨 Runtime 去重并累计 seen count。
- 对列表页直出 MP3 发出预授权下载，也可识别文件区的 MP3 下载按钮；对详情链接保存临时候选并在导航后继续查找。
- 一轮存在多个附件时先建立全部下载意图，宿主等该 Runtime 的预留/下载中记录全部终态后才发完成事件；导航打断预留与点击之间的窗口时，下一次注入可继续触发尚未开始的预留项。
- 识别 `/login` 或登录页标志文本后发出认证事件，宿主自动暂停同一 Runtime 进入人工接管。
- 详情页找不到预期 MP3 时报告 page-changed，宿主同样暂停而不是让 workflow 空等。
- 没有新附件时发送合成完成事件，使本轮 workflow 正常结束而非永久等待。

默认 selector 综合了通用语义与公开实现样本中的 `.topic-container`、正文容器和 `app-file-gallery .download` 等候选值，但尚未经过用户登录后的生产页面验证。

## 公开页面结构基线

公开实现样本显示，知识星球网页前端可能使用：

- `.topic-container` 或 `app-topic` 作为帖子容器。
- `.talk-content-container`、`.article-content-container`、`.q-content-container`、`.answer-content-container` 等正文容器。
- `app-file-gallery`、`.file-name` 和 `.download` 作为文件与下载入口。
- `api.zsxq.com/v2/files/{file_id}/download_url` 一类文件下载地址。

DOM 不一定暴露稳定 topic ID，一些公开实现需要监听主题 API 响应来建立正文与 `topic_id` 的映射。当前 MVP 只实现 DOM/点击路径；网络响应索引与真实下载 API 接入必须在已认证页面采样后决定，不能把公开样本当成稳定协议。

## Project 配置

计划包含：

- 命名 Profile。
- 首页 URL。
- 当前一个可配置 Collector Strategy；规则或维护边界稳定后可拆成 Feed Scanner、Text Classifier 和 Audio Downloader。
- 常驻或按时区定时运行。
- 最大扫描页数、扫描时长和空结果停止条件。
- 关键词、正则和结构化分类规则。
- 输出根目录、命名格式、磁盘配额。
- 下载、弹窗和 Agent 能力开关。
- 重试、熔断和人工接管策略。

## 正常流程

1. 用户首次手工登录，Profile 保存 Cookie/session。
2. Scheduler 创建 Project Runtime 并导航到首页。
3. 页面健康断言确认登录有效、Feed 可读取。
4. Feed Scanner 从最近检查点开始扫描。
5. 每条内容记录帖子 ID、时间、文本摘要和附件摘要。
6. Text Classifier 先执行确定性规则；无法确定时可选择调用 Agent。
7. 对匹配内容打开详情并确认 MP3 附件。
8. Audio Downloader 点击网站下载入口。
9. Electron `will-download` 将文件导向项目临时目录。
10. 下载完成后校验大小/哈希，并原子移动到最终目录。
11. 保存来源、附件、文件和处理状态，推进检查点。

## 幂等与文件安全

幂等键优先使用：

```text
projectId + postId + attachmentId
```

没有稳定 attachment ID 时退化为规范化 URL；仍没有时使用帖子 ID、文件名和大小组合。

文件规则：

- 清理路径分隔符、保留名称和不可见字符。
- 最终路径必须位于项目输出目录中。
- 未完成文件只存在于 `tmp/`。
- 完成后使用同卷原子移动。
- 同名同哈希视为已存在；同名不同内容按规则增加后缀。
- 磁盘空间不足时停止新下载，不删除用户已有文件。

## 故障与恢复

### 登录失效

Strategy 已能通过 URL 和页面标志文本报告登录失效，宿主随后自动“暂停并接管”：冻结 workflow 等待预算、停止 Project Strategy、保留当前 URL/Profile/浏览器槽，用户完成登录后可恢复原 Runtime。该链路已通过本地登录页探针；真实站点仍需验证认证后恢复断言和页面标志的稳定性。

### 导航或网络失败

按退避策略重试；达到预算后 reload、忽略缓存 reload 或重建 view。

### renderer 崩溃

BrowserSupervisor 重建 `WebContentsView`，绑定原 Profile，返回最近持久化检查点。

### 应用崩溃

Watchdog 重启应用。Runtime 从磁盘记录判断未完成下载和最后已提交业务项，不重复处理已完成项。

### 页面结构变化

保存截图、DOM/AX 和错误 selector。确定性备用定位失败后暂停该 Strategy，允许人工或 Agent 生成候选修复。

### 下载失败

按 HTTP/网络、登录、文件、磁盘和用户取消分类。临时文件保留策略由配置决定，最终记录失败原因。

## 项目目录

```text
project-root/
  downloads/
  tmp/
  records/
  logs/
```

建议 `records/` 保存结构化业务记录和下载 manifest，不存账号密钥。

## 项目监控

额外显示：

- 上次成功扫描时间。
- 当前帖子和 workflow 步骤。
- 本轮扫描、匹配、跳过和下载数量。
- 下载速度、累计字节和剩余队列。
- 最近成功文件。
- 登录状态、连续失败和当前恢复级别。

## 验收

1. 首次登录后可在后续运行中复用 Profile。
2. 从检查点扫描并正确筛选测试样本。
3. MP3 下载到指定目录，元数据完整。
4. 相同帖子重复出现、项目重启或补跑时不重复下载。
5. 下载中强杀 renderer 和 Electron main process 后能够恢复。
6. 断网、结构变化和磁盘不足不会造成无限重试或损坏最终文件。
7. 与另一个 Project 并发运行时，Profile、文件和状态不串扰。

## 当前自动化证据

`npm run smoke:knowledge-planet` 在本地受控页面执行四轮：

1. 扫描一条匹配、一条跳过的帖子；同一匹配项通过两个直链和一个页面按钮下载三个模拟 MP3（4,096、2,048、1,024 bytes）。
2. 再次扫描相同内容，业务项 seen count 增长，但 manifest 和最终文件仍只有三个。
3. 先进入登录页并自动暂停，人工导航到 Feed 后恢复原 Runtime，再次完成且不重复下载。
4. 从列表进入缺少 MP3 的变更详情页，按 page-changed 自动暂停；人工修复后恢复并完成。

四轮 Runtime 的 scanned/matched/skipped 均为 2/1/1；业务项 seen count 为 4。第一轮下载计数为 3、累计 7,168 bytes，后续三轮下载计数为 0；三个 SHA-256、空临时目录、批量完成聚合、导航中断后的预留恢复、两类暂停/恢复事件和模板安装 IPC 均纳入门禁。此证据只证明宿主闭环，不替代真实站点验收。

## 待用户确认

- 用户要监听的具体星球/Feed URL（官方网页入口已经确认）。
- “指定类型文本”的规则和样本。
- 首次扫描的历史范围。
- 常驻监听还是每日具体时刻。
- 输出目录和文件命名格式。
- 是否允许分类阶段调用 Agent。
