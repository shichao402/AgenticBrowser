# ADR-0008: 使用 Relkit 引擎实现应用内更新

- Status: Accepted
- Date: 2026-11-13

## Context

AgenticBrowser 此前只通过 GitHub Release 分发安装包，用户需要自己去发布页下载新版本。开发版与正式版并排安装后，两档都需要可靠的升级路径。自研下载、校验、原地替换和回滚的成本高，而 Relkit 已提供发布服务（`https://publish.firoyang.com`）、签名的 bootstrap、更新引擎二进制和 CI 发布工具链。

## Decision

- 宿主通过子进程调用随包分发的 Relkit 更新引擎，协议为 `relkit.updater.v2`（protocol 5）：stdin 写入一条 ProtoJSON 请求，stdout 每行一个事件，首行为 Capabilities；两侧严格解析，引擎协议低于宿主要求时报 `UPDATER_TOO_OLD`。
- proto 副本放在 `proto/`，由 `buf generate` 生成到 `src/main/updater/gen/`，运行时依赖 `@bufbuild/protobuf`。`npm run proto:check` 在 `npm run check` 中校验生成代码与 proto 一致。
- 产品名为 `AgenticBrowser`，渠道沿用默认两档：`release` 档对应 tag `v*` 触发的 stable 发布，`dev` 档对应 `workflow_dispatch` 触发的 dev 发布。每个安装渠道只检查自己的档。
- 宿主不解析 bootstrap，也不做签名校验；信任根、下载校验和回滚全部由引擎负责，宿主只负责展示状态和触发 check、download、apply。
- `INTERNAL` 与 `FULL_INSTALL` 都走应用内下载再 apply（后者由引擎运行安装程序）；只有 `UNSPECIFIED` 才提示用户去发布页手动下载。
- 发布由 `.github/workflows/release.yml` 完成：check、申领 release code、三平台（windows-amd64、darwin-arm64、darwin-amd64）构建并产出 Relkit 制品、发布到 Relkit 服务，stable 额外创建 GitHub Release。`package.yml` 只保留手动触发，用于不发布的打包验证。
- macOS 包继续使用 ad-hoc 签名（`CSC_IDENTITY_AUTO_DISCOVERY=false`），制品生产阶段执行 `codesign --verify`。

## Consequences

- 用户可以在应用内完成检查、下载和安装，dev 与 stable 并排安装时互不干扰。
- 新增 `@bufbuild/protobuf` 运行时依赖和 `buf` 开发依赖；proto 升级需要同步更新副本并重新生成。
- 首次发布前需要在 Relkit 管理端注册产品并签发上传 token，存为 GitHub secret `RELKIT_UPLOAD_TOKEN`。
- mac 未使用开发者证书签名，首次安装仍需用户手动放行 Gatekeeper；后续由引擎原地替换。
- Windows 上宿主退出与引擎 watchdog 接管之间存在时序窗口，风险较低，出现问题时引擎会进入 `NEEDS_ATTENTION` 或回滚，并在下次启动时上报。

## Rejected alternatives

- electron-updater：需要自建更新源与签名约定，且不支持与 Relkit 一致的渠道和回滚模型。
- 宿主内解析 bootstrap 并自行验签：重复引擎职责，扩大信任面。
- 把 `FULL_INSTALL` 视为手动更新：会让 Windows 安装器类更新失去应用内路径，体验退化。
