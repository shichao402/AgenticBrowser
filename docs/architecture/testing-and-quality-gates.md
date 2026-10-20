# 测试与质量门禁

本文说明这个仓库的验证体系由哪几层组成、各自负责什么、以及本地和 CI 上怎么跑。
新增功能时请对照本文决定该补哪一层，而不是只补最省事的那一层。

## 分层原则

验证按「离用户越近越贵」分层，每层只负责别层覆盖不到的风险：

| 层 | 覆盖什么 | 不适合覆盖什么 | 命令 |
| --- | --- | --- | --- |
| 单元测试 | 纯函数、状态机、存储、策略解析等不依赖 Electron 单例的逻辑 | 真实窗口、进程派生、渲染进程崩溃 | `npm run test` |
| 冒烟 | 启动编排、watchdog 守护、下载事务、故障恢复、多视图捕获 | 细粒度分支 | `npm run smoke:*` |
| 静态检查 | 类型、风格、未使用依赖、版本一致性 | 运行时行为 | `npm run check` |

一个常见误区是把「能在单元测试里跑通」当成「接线正确」。模块被拆到多个文件后，
入口与实现各持一份状态副本这类缺陷，静态检查和单测都发现不了，只有真正加载入口
或跑一次真实启动才会暴露。这类问题请用冒烟或入口级测试覆盖。

## 单元测试

```bash
npm run test            # 全量
npm run test:watch      # 监听模式
npm run test:coverage   # 带覆盖率，并校验阈值
```

测试位于 `tests/`，命名 `*.test.ts`。覆盖率阈值定义在
[`vitest.config.ts`](../vitest.config.ts)，会随 `npm run check` 在 CI 强制执行。

统计范围刻意排除了入口编排（`src/main/index.ts`）、冒烟宿主、渲染层与
`src/shared/contracts.ts`：这些要么依赖真实窗口和进程派生，要么是纯类型声明，
计入单元覆盖率只会稀释信号，真正该管的是它们能否通过冒烟。

阈值取实测值的下沿，作用是防止回退。新增逻辑时如果整体覆盖率上升，可以顺手把
阈值往上调；不要为了过门禁而下调阈值掩盖下降。

当前实测约 54% 语句 / 63% 分支 / 61% 函数 / 54% 行。数字不高的主要原因是
`BrowserSupervisor` 与若干 Electron 强耦合模块仍计入了统计范围，它们由冒烟覆盖。
把纯逻辑从这些模块里剥出来是提升覆盖率最有效的方式，这比为了数字去写形式化的
测试更有价值。

### 写测试时的注意点

- `noUncheckedIndexedAccess` 已开启，`array[0]` 的类型包含 `undefined`。
  先用 `expect(arr).toHaveLength(n)` 收窄，再取元素。
- 涉及安全边界的校验（协议白名单、字段白名单、数值边界）务必覆盖拒绝分支。
  例如下载意图只允许 `http:` / `https:`，`file:` 与 `data:` 必须被拒绝。
- 判断一个测试是否真的有效，最可靠的办法是临时把被测实现改坏，确认它会失败。
  本次修复下载幂等缺陷时，正是靠这一步发现第一版修复把「新运行可重试」的语义
  也一起改坏了。

## 冒烟

冒烟会真实拉起 Electron 进程，覆盖单元测试触达不到的编排与恢复链路。场景清单：

| 场景 | 命令 | 重点 |
| --- | --- | --- |
| Phase 0 | `npx electron . --smoke-test` | 视图隔离、preload、策略注入、崩溃重建、捕获性能 |
| Recovery | `npx electron . --recovery-smoke-test` | 恢复动作序列与熔断、能力策略、多标签 |
| Strategy fault | `npx electron . --strategy-fault-smoke-test` | 策略心跳超时、隔离、渲染进程回收 |
| Strategy workspace | `npx electron . --strategy-workspace-smoke-test` | 策略工作区增删改 |
| Project download | `npx electron . --project-download-smoke-test` | 下载事务与幂等 |
| Project download recovery | `node scripts/project-download-recovery-smoke.mjs` | 下载中断后恢复 |
| Project download fault | `node scripts/project-download-fault-smoke.mjs` | 磁盘/网络故障分类 |
| Project download renderer recovery | `node scripts/project-download-renderer-recovery-smoke.mjs` | 下载中渲染进程崩溃 |
| Project concurrency | `npx electron . --project-concurrency-smoke-test` | 多项目并发调度 |
| Project takeover | `npx electron . --project-takeover-smoke-test` | 人工接管与恢复自动化 |
| Automation playground | `npx electron . --automation-playground-smoke-test` | 真实站点端到端流程 |
| Watchdog | `node scripts/watchdog-smoke.mjs` | 主进程心跳与守护重启 |

每个 `npm run smoke:*` 内部都会先 `npm run build`，本地单跑方便；CI 里为了不重复
构建十二次，改为统一 build 后直接调用 electron 或脚本本身。

冒烟会写出 `*-smoke-result.json`，这些文件已在 `.gitignore` 中忽略，CI 失败时作为
artifact 上传，便于离线分析。

### 排查冒烟失败

- 先看是哪个场景：CI 用 `::group::` 折叠了每个场景的输出，直接搜场景名。
- 场景内的断言字段（`passed` 之外的布尔字段）通常已经指明了失败维度，例如
  `failedNavigationRejected=false` 说明导航失败没有被上报给调用方。
- 恢复类场景依赖完整的动作序列（`reload` → `reload-ignore-cache` →
  `clear-cache-and-reload` → `recreate-view`）和最终熔断状态，改动恢复逻辑时
  务必确认这两个断言仍然成立。

## CI 门禁

两个工作流都跑在 `macos-latest` 与 `windows-latest` 上——两个平台的进程模型与
路径语义不同，只在一个平台验证过的代码路径会直接进到另一个平台的产物里。

- `ci.yml`：`npm run check`，即版本一致性、格式、lint、类型、覆盖率、构建、依赖审计。
- `smoke.yml`：构建一次后串行跑全部冒烟场景，每条命令有 `timeout` 硬上限。

冒烟必须串行：多个场景会同时争用图形会话和固定端口，并发跑会互相干扰。

单条命令加硬超时是为了把「挂住」变成「立刻失败的明确错误」。Windows 上曾出现
Phase 0 挂住十余分钟仍未结束的情况，没有超时时作业会一直占着 runner，而且运行
结束前拿不到日志，排查成本很高。

## 已知的验证盲区

诚实记录当前没覆盖到的部分，避免高估现有门禁：

- `BrowserSupervisor`（约 1900 行）没有单元测试，它与 Electron 强耦合，
  目前只靠冒烟覆盖。改动恢复语义时风险最高。它的策略网络桥接部分
  （请求头白名单、响应大小上限、重定向判定）已经抽到
  `src/main/strategy-network.ts`，这部分有完整边界测试；
  剩余部分仍未剥离，抽离时请一并补测。
- 打包产物只验证了 `smoke:watchdog:packaged` 一条路径，安装包层面的验证仍靠手动。
- 自动化验收模板依赖公网测试站点，网络波动会影响该场景。
- `src/main/index.ts` 仍有近 3000 行，只通过一条入口接线测试间接覆盖，
  进一步拆分时需要同步补充针对性的接线断言。
