import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  loadChannels,
  resolveChannel,
  validatePair
} from '../scripts/channel-identity.mjs'
import {
  DEFAULT_CHANNEL_NAME,
  RELEASE_PROFILE_FALLBACK,
  isChannelName,
  resolveChannelName,
  resolveProfile,
  type ChannelProfile
} from '../src/shared/channel-identity'

const root = process.cwd()
const manifest = JSON.parse(
  readFileSync(join(root, 'VERSION.json'), 'utf8')
) as { version: string; channels: Record<string, ChannelProfile> }

function profile(overrides: Partial<ChannelProfile> = {}): ChannelProfile {
  return {
    displayName: 'Product',
    installDirectoryName: 'Product',
    appId: 'com.example.product',
    iconSet: 'release',
    userDataDirectoryName: 'Product',
    artifactPrefix: 'Product',
    ...overrides
  }
}

describe('resolveChannelName', () => {
  it('accepts both known channels', () => {
    expect(resolveChannelName('release')).toBe('release')
    expect(resolveChannelName('dev')).toBe('dev')
  })

  it('falls back to release for anything else', () => {
    // 异常值必须落到正式档：让构建产出开发档身份比失败更危险。
    for (const value of [undefined, null, '', 'Dev', 'stable', 0, {}, []]) {
      expect(resolveChannelName(value)).toBe(DEFAULT_CHANNEL_NAME)
    }
  })
})

describe('isChannelName', () => {
  it('is case sensitive', () => {
    expect(isChannelName('DEV')).toBe(false)
    expect(isChannelName('dev')).toBe(true)
  })
})

describe('resolveProfile', () => {
  it('keeps a complete injected profile untouched', () => {
    const injected = profile({
      displayName: 'Product Dev',
      installDirectoryName: 'ProductDev',
      appId: 'com.example.product.dev',
      iconSet: 'dev',
      userDataDirectoryName: 'ProductDev',
      artifactPrefix: 'Product-Dev'
    })
    expect(resolveProfile(injected, 'dev')).toEqual(injected)
  })

  it('falls back to the release profile when nothing was injected', () => {
    // 单元测试与直接 tsc 运行时没有构建期注入，必须还能拿到合法身份。
    expect(resolveProfile(undefined, 'release')).toEqual(
      RELEASE_PROFILE_FALLBACK
    )
  })

  it('fills individual missing fields from the fallback', () => {
    const partial = { displayName: 'Custom' }
    const resolved = resolveProfile(partial, 'release')
    expect(resolved.displayName).toBe('Custom')
    expect(resolved.appId).toBe(RELEASE_PROFILE_FALLBACK.appId)
  })

  it('rejects empty and non string fields', () => {
    const resolved = resolveProfile(
      { displayName: '   ', appId: 42, iconSet: null },
      'release'
    )
    expect(resolved.displayName).toBe(RELEASE_PROFILE_FALLBACK.displayName)
    expect(resolved.appId).toBe(RELEASE_PROFILE_FALLBACK.appId)
    expect(resolved.iconSet).toBe(RELEASE_PROFILE_FALLBACK.iconSet)
  })

  it('forces visible separation when dev gets a release shaped identity', () => {
    // 注入丢失时如果两档都退回同一份身份，它们会抢同一个数据目录、
    // 同一把单实例锁。这条兜底保证至少还能并排跑起来。
    const resolved = resolveProfile(undefined, 'dev')
    expect(resolved.appId).toBe(`${RELEASE_PROFILE_FALLBACK.appId}.dev`)
    expect(resolved.installDirectoryName).toBe(
      `${RELEASE_PROFILE_FALLBACK.installDirectoryName}Dev`
    )
    expect(resolved.userDataDirectoryName).toBe(
      `${RELEASE_PROFILE_FALLBACK.userDataDirectoryName}Dev`
    )
    expect(resolved.displayName.endsWith(' Dev')).toBe(true)
    expect(resolved.iconSet).toBe('dev')
  })

  it('does not alter a dev profile that is already distinct', () => {
    const injected = profile({
      displayName: 'Product Dev',
      installDirectoryName: 'ProductDev',
      appId: 'com.example.product.dev',
      iconSet: 'dev',
      userDataDirectoryName: 'ProductDev',
      artifactPrefix: 'Product-Dev'
    })
    expect(resolveProfile(injected, 'dev')).toEqual(injected)
  })
})

describe('validatePair', () => {
  it('accepts a consistent pair', () => {
    expect(
      validatePair({
        release: profile(),
        dev: profile({
          displayName: 'Product Dev',
          installDirectoryName: 'ProductDev',
          appId: 'com.example.product.dev',
          iconSet: 'dev',
          userDataDirectoryName: 'ProductDev',
          artifactPrefix: 'Product-Dev'
        })
      })
    ).toEqual([])
  })

  it('rejects a dev directory that is not the release name plus Dev', () => {
    const problems = validatePair({
      release: profile(),
      dev: profile({
        displayName: 'Product Dev',
        installDirectoryName: 'Product-Development',
        appId: 'com.example.product.dev',
        iconSet: 'dev',
        userDataDirectoryName: 'ProductDev',
        artifactPrefix: 'Product-Dev'
      })
    })
    expect(problems.join()).toContain('ProductDev')
  })

  it('rejects whitespace in the dev directory name', () => {
    const problems = validatePair({
      release: profile(),
      dev: profile({
        displayName: 'Product Dev',
        installDirectoryName: 'Product Dev',
        appId: 'com.example.product.dev',
        iconSet: 'dev',
        userDataDirectoryName: 'ProductDev',
        artifactPrefix: 'Product-Dev'
      })
    })
    expect(problems.join()).toContain('空白')
  })

  it('rejects every shared identity field', () => {
    const cases: Array<[keyof ChannelProfile, string]> = [
      ['displayName', '显示名'],
      ['appId', '应用标识'],
      ['userDataDirectoryName', '数据目录名'],
      ['iconSet', '图标集'],
      ['artifactPrefix', '安装包前缀']
    ]
    for (const [field, label] of cases) {
      const dev = profile({
        displayName: 'Product Dev',
        installDirectoryName: 'ProductDev',
        appId: 'com.example.product.dev',
        iconSet: 'dev',
        userDataDirectoryName: 'ProductDev',
        artifactPrefix: 'Product-Dev'
      })
      const shared = { ...dev, [field]: profile()[field] }
      const problems = validatePair({ release: profile(), dev: shared })
      expect(problems.join()).toContain(label)
    }
  })
})

describe('resolveChannel (script side)', () => {
  it('defaults to release', () => {
    expect(resolveChannel(undefined)).toBe('release')
    expect(resolveChannel('')).toBe('release')
  })

  it('rejects unknown names instead of silently defaulting', () => {
    // 脚本侧与运行时侧故意不同：拼错的档位名应该让打包失败，
    // 而不是产出一个名字对不上的包。
    expect(() => resolveChannel('prod')).toThrowError(/未知档位/)
  })
})

describe('VERSION.json in this repository', () => {
  it('declares a valid pair of channels', () => {
    const { profiles } = loadChannels(root)
    expect(profiles.release.installDirectoryName).toBe('AgenticBrowser')
    expect(profiles.dev.installDirectoryName).toBe('AgenticBrowserDev')
  })

  it('keeps the shipping configuration on the release channel', () => {
    // 仓库里的产品配置必须始终描述正式档，否则正常人装到的是开发包。
    expect(manifest.channels.release?.displayName).toBe('AgenticBrowser')
    expect(manifest.channels.dev?.displayName).toBe('AgenticBrowser Dev')
  })

  it('gives the dev channel its own app identity', () => {
    expect(manifest.channels.dev?.appId).not.toBe(
      manifest.channels.release?.appId
    )
  })
})
