# 知识星球文本与 MP3 采集试点

- Status: Runtime infrastructure ready; real-site pilot pending
- Target phase: Phase 3

## 用户目标

用户打开 AgenticBrowser 后，项目复用已有登录状态，监听或定时扫描知识星球首页，筛选指定类型文本，进入匹配内容并点击下载其中的 MP3，将文件放入项目指定目录。

Project/Profile/Strategy/workflow、下载事务、幂等和模拟 MP3 闭环已经具备；本文中的真实知识星球选择器、分类规则、登录处理和故障验收尚未执行，不能视为试点完成。

## Project 配置

计划包含：

- 命名 Profile。
- 首页 URL。
- Feed Scanner、Text Classifier、Audio Downloader 三个 Strategy。
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

暂停 Runtime，保留当前 URL 和帖子检查点，显示人工登录入口。登录成功后重新验证首页再续跑。

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

## 待用户确认

- 知识星球实际首页 URL。
- “指定类型文本”的规则和样本。
- 首次扫描的历史范围。
- 常驻监听还是每日具体时刻。
- 输出目录和文件命名格式。
- 是否允许分类阶段调用 Agent。
