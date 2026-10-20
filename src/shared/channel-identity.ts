// 档位身份的类型与运行时收敛规则。
//
// 这里不读 VERSION.json：构建期由 electron.vite.config.ts 解析清单后
// 通过 define 注入，运行时只读注入结果。清单的校验逻辑只存在于
// scripts/channel-identity.mjs，避免两处规则分叉。

export const CHANNEL_NAMES = ['release', 'dev'] as const

export type ChannelName = (typeof CHANNEL_NAMES)[number]

export const DEFAULT_CHANNEL_NAME: ChannelName = 'release'

/**
 * 一个档位的完整身份。
 *
 * 显示名、安装目录名、应用标识是三个独立字段：显示名给人看并用于
 * 安装包与快捷方式，目录名决定装在哪个兄弟目录，标识决定数据目录
 * 与卸载登记。把它们合成一个字段是并排安装最常见的失败原因。
 */
export interface ChannelProfile {
  displayName: string
  installDirectoryName: string
  appId: string
  iconSet: string
  userDataDirectoryName: string
  artifactPrefix: string
}

export type ChannelProfiles = Record<ChannelName, ChannelProfile>

export function isChannelName(value: unknown): value is ChannelName {
  return (
    typeof value === 'string' &&
    (CHANNEL_NAMES as readonly string[]).includes(value)
  )
}

/** 缺省与非法值都落到正式档，避免异常构建产出开发档身份。 */
export function resolveChannelName(raw: unknown): ChannelName {
  return isChannelName(raw) ? raw : DEFAULT_CHANNEL_NAME
}

const PROFILE_FIELDS = [
  'displayName',
  'installDirectoryName',
  'appId',
  'iconSet',
  'userDataDirectoryName',
  'artifactPrefix'
] as const

/**
 * 正式档身份兜底。
 *
 * 未被构建期替换时（单元测试、直接 tsc 运行）用它，
 * 保证运行时永远拿得到一份合法的正式档身份。
 */
export const RELEASE_PROFILE_FALLBACK: ChannelProfile = {
  displayName: 'AgenticBrowser',
  installDirectoryName: 'AgenticBrowser',
  appId: 'com.firoyang.agenticbrowser',
  iconSet: 'release',
  userDataDirectoryName: 'AgenticBrowser',
  artifactPrefix: 'AgenticBrowser'
}

/**
 * 开发档的最小隔离兜底。
 *
 * 注入缺失时两档都会退回同一份正式档身份，那样它们会抢同一个数据
 * 目录、同一把单实例锁，并排安装直接失效。这里用档位名补出差异，
 * 保证即使构建期注入出问题，两档仍能共存。
 */
function separateDevIdentity(profile: ChannelProfile): ChannelProfile {
  if (profile.appId !== RELEASE_PROFILE_FALLBACK.appId) {
    // 已经是独立的开发档身份，不要覆盖真实配置。
    return profile
  }
  return {
    ...profile,
    appId: `${RELEASE_PROFILE_FALLBACK.appId}.dev`,
    installDirectoryName: `${RELEASE_PROFILE_FALLBACK.installDirectoryName}Dev`,
    userDataDirectoryName: `${RELEASE_PROFILE_FALLBACK.userDataDirectoryName}Dev`,
    displayName: `${RELEASE_PROFILE_FALLBACK.displayName} Dev`,
    artifactPrefix: `${RELEASE_PROFILE_FALLBACK.artifactPrefix}-Dev`,
    iconSet: 'dev'
  }
}

/**
 * 把构建期注入的值收敛成一份完整身份。
 *
 * 字段缺失或类型不对时回落到正式档兜底，而不是抛错：身份只影响
 * 窗口标题、数据目录和安装位置，不该让应用起不来。但名称本身要
 * 收敛成合法档位，避免出现第三种身份。
 */
export function resolveProfile(
  raw: unknown,
  channelName: ChannelName = DEFAULT_CHANNEL_NAME
): ChannelProfile {
  const resolved: ChannelProfile = { ...RELEASE_PROFILE_FALLBACK }
  if (typeof raw === 'object' && raw !== null) {
    const record = raw as Record<string, unknown>
    for (const field of PROFILE_FIELDS) {
      const value = record[field]
      if (typeof value === 'string' && value.trim().length > 0) {
        resolved[field] = value
      }
    }
  }
  return channelName === 'dev' ? separateDevIdentity(resolved) : resolved
}
