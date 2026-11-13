import type { ChannelName } from '../../shared/channel-identity'
import { currentChannel } from '../../shared/channel-runtime'

// 本构建的发布身份。全部来自构建期注入（scripts/relkit_producer.mjs →
// electron.vite.config.ts），只有 CI 发布构建才齐全；本地构建、开发运行与
// 单元测试拿到的是空串，此时自动更新整体停用。

/** 与 relkit.project.json 的 product 一致；引擎要求它等于 bootstrap 里的产品。 */
export const RELKIT_PRODUCT = 'AgenticBrowser'

export interface ReleaseIdentity {
  product: string
  /** 服务器渠道名：release 档对应 stable，dev 档对应 dev。 */
  channel: 'stable' | 'dev'
  code: bigint
  version: string
  /** relkit.runtime-bootstrap/2 原文，只交给引擎，宿主不解析。 */
  bootstrap: string
}

export function serverChannelFor(profile: ChannelName): 'stable' | 'dev' {
  return profile === 'dev' ? 'dev' : 'stable'
}

export interface InjectedRelease {
  bootstrap: unknown
  code: unknown
  version: unknown
}

/** 三项齐全且 code 是正整数才算接入；缺任何一项都返回 null。 */
export function resolveReleaseIdentity(
  injected: InjectedRelease,
  profile: ChannelName
): ReleaseIdentity | null {
  const { bootstrap, code, version } = injected
  if (typeof bootstrap !== 'string' || bootstrap.trim().length === 0) {
    return null
  }
  if (typeof code !== 'string' || !/^[1-9]\d*$/.test(code)) {
    return null
  }
  if (typeof version !== 'string' || version.trim().length === 0) {
    return null
  }
  return {
    product: RELKIT_PRODUCT,
    channel: serverChannelFor(profile),
    code: BigInt(code),
    version,
    bootstrap
  }
}

function readInjected(): InjectedRelease {
  // 与 channel-runtime 相同：未被 define 替换时（测试、tsc）用 typeof 兜底。
  return {
    bootstrap:
      typeof __AGENTIC_RELKIT_BOOTSTRAP__ === 'undefined'
        ? undefined
        : __AGENTIC_RELKIT_BOOTSTRAP__,
    code:
      typeof __AGENTIC_RELEASE_CODE__ === 'undefined'
        ? undefined
        : __AGENTIC_RELEASE_CODE__,
    version:
      typeof __AGENTIC_RELEASE_VERSION__ === 'undefined'
        ? undefined
        : __AGENTIC_RELEASE_VERSION__
  }
}

export function currentReleaseIdentity(): ReleaseIdentity | null {
  return resolveReleaseIdentity(readInjected(), currentChannel)
}
