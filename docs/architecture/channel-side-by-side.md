# 正式档与开发档并排安装

同一台机器上同时保留正式版和开发版。两档是兄弟目录里的两套独立安装，
不是同一目录里换文件。

## 两档的身份字段

字段定义在 `VERSION.json` 的 `channels` 下。显示名、安装目录名、应用标识
是三个独立字段，合并它们会直接导致并排安装失败。

| 字段 | 正式档 | 开发档 | 作用 |
|---|---|---|---|
| `displayName` | `AgenticBrowser` | `AgenticBrowser Dev` | 窗口标题、安装包名、快捷方式 |
| `installDirectoryName` | `AgenticBrowser` | `AgenticBrowserDev` | 安装根下的兄弟目录 |
| `appId` | `com.firoyang.agenticbrowser` | `com.firoyang.agenticbrowser.dev` | 数据目录与卸载登记 |
| `userDataDirectoryName` | `AgenticBrowser` | `AgenticBrowserDev` | 运行时数据目录 |
| `iconSet` | `release` | `dev` | 图标来源 |
| `artifactPrefix` | `AgenticBrowser` | `AgenticBrowser-Dev` | 安装包文件名前缀 |

单实例锁的 key 由档位名派生（见 `src/main/index.ts`），两档不同，因此可以
同时运行互不顶替。

## 身份在构建期注入

`electron.vite.config.ts` 读 `VERSION.json`，把选中的档位写进产物：

```bash
AGENTIC_CHANNEL=dev npm run build   # 开发档身份
npm run build                        # 正式档身份（缺省）
```

构建期用 `define` 替换 `__AGENTIC_CHANNEL__` 与 `__AGENTIC_PROFILE__`，
运行时只读注入结果，不再看环境变量或文件。选择变了必须重新构建，
增量缓存不能留下上一档的身份。

档位名拼错会让构建直接失败，而不是静默退回正式档——否则你会以为在打
开发包，实际拿到正式包。

## 仓库配置只描述正式档

`package.json` 的 `build` 段始终是正式档身份。开发档的显示名、标识与产物
前缀由 `scripts/package-channel.mjs` 用一次性 CLI 覆盖传入，不写回文件。

构建结束（无论成功失败）都会把 `out/` 重新刷成正式档，工作区不会停在
开发档上。

## 本地部署

两档走同一条路径，差别只有档位和目标目录：

```bash
npm run deploy:release   # 覆盖安装到 <安装根>/AgenticBrowser
npm run deploy:dev       # 装在旁边：<安装根>/AgenticBrowserDev
```

路径固定为：

1. 按档位构建，注入身份
2. 打出真正的安装包（不是拷贝散文件）
3. 结束目标目录里正在运行的进程
4. 静默安装到钉死的目录，不跟随安装器记住的上次向导路径
5. 结果与人工安装一致：有卸载入口，有该档自己的快捷方式

不做「拷贝二进制代替安装」：拷贝没有卸载登记和快捷方式，目录布局也和
真正安装不同，下一轮静默安装对不齐。

Windows 当前用户安装的安装根是 `%LOCALAPPDATA%`。NSIS 要求 `/D` 目标目录
放在参数最后且不加引号，否则会被忽略并回落到「按显示名生成文件夹」。

macOS 的安装根是 `/Applications`，两档分别落成 `AgenticBrowser.app` 与
`AgenticBrowserDev.app`。包装从 electron-builder 的 `dir` 产物取，用 `ditto`
搬运以保留资源分叉，覆盖前先删旧包避免新旧文件混在一起。安装后用
`defaults read` 读回 `CFBundleIdentifier`，与目标档位比对，确认装上去的
确实是这一档。本地构建跳过签名（`identity=null`）。

## 验收清单

- [ ] 正式版落在该产品的正常安装路径下
- [ ] 开发版目录是正式版目录名后直接加 `Dev`，中间没有空格
- [ ] 显示名、安装目录名、应用标识是三个分开的字段
- [ ] 两档的标识、图标、数据目录、单实例锁都不同
- [ ] 仓库里的 `package.json` 仍是正式档
- [ ] 开发档只在当次构建注入，结束后 `out/` 已恢复正式档
- [ ] 两档都是「打安装包，再静默安装到钉死的目录」
- [ ] 正式版静默安装覆盖的是规范目录，不是上次向导选过的地方
- [ ] 两套能同时留在机器上，并各自卸载

## 失败模式

| 表象 | 常见原因 |
|---|---|
| 开发版目录带空格，或和显示名一模一样 | 静默安装没改写目标目录，安装器用了显示名 |
| 装回了上次向导选的路径 | 静默参数没盖过安装器记住的位置 |
| 静默参数被忽略 | 路径位置或引号不符合该安装器的规则 |
| 覆盖安装失败，文件仍是旧的 | 目标目录里的进程没先停 |
| 开发版没有卸载入口和快捷方式 | 用拷贝产物代替了安装包 |
| 两档抢同一份配置或同一个端口 | 标识或独占资源相同 |
| 仓库里留下开发档身份 | 构建结束后没有恢复正式档 |
| 换档后二进制仍是上一档 | 注入没有因档位变化而重做 |

## 相关文件

- `VERSION.json`：两档身份清单
- `scripts/channel-identity.mjs`：档位解析与关系校验（唯一一份规则）
- `scripts/channel-check.mjs`：CI 里跑的清单校验
- `scripts/package-channel.mjs`：按档位构建打包，并恢复正式档
- `scripts/deploy-channel.mjs`：两档共用的本地部署路径
- `src/shared/channel-identity.ts`：运行时身份收敛与开发档兜底
- `src/shared/channel-runtime.ts`：运行时读取档位身份的唯一入口
