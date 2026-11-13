import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadChannels } from '../scripts/channel-identity.mjs'
import {
  computeRelease,
  profileForChannel,
  readBaseVersion,
  releaseCodeFromVersion,
  semverFromVersion
} from '../scripts/relkit-version.mjs'
import {
  PRODUCT,
  TARGETS,
  applyOverrides,
  artifactNames,
  assertEngineInTree,
  builderConfig,
  validateInput
} from '../scripts/relkit_producer.mjs'
import { hostTarget, stagedUpdaterPath } from '../scripts/stage-relkit.mjs'

describe('relkit-version', () => {
  it('builds stable versions from a matching tag', () => {
    expect(
      computeRelease({
        channel: 'stable',
        tag: 'v1.2.3',
        baseVersion: '1.2.3',
        code: '41'
      })
    ).toEqual({
      channel: 'stable',
      code: 41,
      semver: '1.2.3',
      version: '1.2.3+41',
      profile: 'release'
    })
  })

  it('builds dev versions without a tag', () => {
    expect(
      computeRelease({ channel: 'dev', baseVersion: '1.2.3', code: 5 })
    ).toMatchObject({
      version: '1.2.3-dev.5+5',
      profile: 'dev'
    })
  })

  it('rejects bad inputs', () => {
    expect(() =>
      computeRelease({
        channel: 'stable',
        tag: 'v1.2.4',
        baseVersion: '1.2.3',
        code: 1
      })
    ).toThrow(/tag/)
    expect(() =>
      computeRelease({ channel: 'stable', baseVersion: '1.2.3', code: 1 })
    ).toThrow(/<空>/)
    expect(() =>
      computeRelease({ channel: 'beta', baseVersion: '1.2.3', code: 1 })
    ).toThrow(/渠道/)
    expect(() =>
      computeRelease({ channel: 'dev', baseVersion: '1.2.3', code: '0' })
    ).toThrow(/releaseCode/)
    expect(() =>
      computeRelease({ channel: 'dev', baseVersion: '1.2', code: 1 })
    ).toThrow(/x\.y\.z/)
  })

  it('parses producer versions', () => {
    expect(releaseCodeFromVersion('1.2.3-dev.5+5')).toBe(5)
    expect(semverFromVersion('1.2.3-dev.5+5')).toBe('1.2.3')
    expect(semverFromVersion('1.2.3+41')).toBe('1.2.3')
    expect(() => releaseCodeFromVersion('1.2.3')).toThrow()
    expect(() => releaseCodeFromVersion('1.2.3+0')).toThrow()
    expect(() => semverFromVersion('1.2.3-beta+4')).toThrow()
    expect(profileForChannel('stable')).toBe('release')
    expect(profileForChannel('dev')).toBe('dev')
  })

  it('reads VERSION.json', () => {
    expect(readBaseVersion()).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('relkit_producer', () => {
  const input = {
    schema: 'relkit.artifact-producer-input/2',
    product: PRODUCT,
    version: '0.1.0-dev.5+5',
    channel: 'dev',
    target: 'darwin-arm64',
    outputDirectory: '/tmp/out'
  }

  it('validates producer input', () => {
    expect(validateInput(input)).toMatchObject({
      platform: 'darwin',
      arch: 'arm64',
      profile: 'dev',
      code: 5,
      semver: '0.1.0'
    })
    expect(() => validateInput({ ...input, schema: 'x' })).toThrow(/schema/)
    expect(() => validateInput({ ...input, product: 'Other' })).toThrow(
      /product/
    )
    expect(() => validateInput({ ...input, target: 'linux-amd64' })).toThrow(
      /target/
    )
    expect(() => validateInput({ ...input, outputDirectory: '' })).toThrow(
      /outputDirectory/
    )
  })

  it('covers exactly the selectors the host maps', () => {
    expect(Object.keys(TARGETS).sort()).toEqual([
      'darwin-amd64',
      'darwin-arm64',
      'windows-amd64'
    ])
  })

  it('names artifacts per target', () => {
    expect(
      artifactNames({
        artifactPrefix: 'AgenticBrowser',
        semver: '0.1.0',
        code: 5,
        target: 'windows-amd64'
      })
    ).toEqual({
      installer: 'AgenticBrowser-0.1.0-5-windows-amd64-setup.exe',
      payload: 'AgenticBrowser-0.1.0-5-windows-amd64.payload.zip'
    })
    expect(
      artifactNames({
        artifactPrefix: 'A',
        semver: '0.1.0',
        code: 5,
        target: 'darwin-arm64'
      }).installer
    ).toBe('A-0.1.0-5-darwin-arm64.dmg')
  })

  it('applies dotted overrides', () => {
    expect(
      applyOverrides({ a: { b: 1 }, c: 'x' }, { 'a.d': 2, 'c.e': 3, f: 4 })
    ).toEqual({
      a: { b: 1, d: 2 },
      c: { e: 3 },
      f: 4
    })
  })

  it('bundles the engine next to the executable', () => {
    const channels = loadChannels(join(import.meta.dirname, '..'))
    const baseConfig = { appId: 'base', mac: { hardenedRuntime: true } }
    const mac = builderConfig({
      baseConfig,
      profile: 'release',
      channelProfile: channels.profiles.release,
      target: 'darwin-arm64',
      updaterPath: '/stage/relkit-updater',
      outputDirectory: '/out'
    })
    expect(mac.extraFiles).toEqual([
      { from: '/stage/relkit-updater', to: 'MacOS/relkit-updater' }
    ])
    expect(mac.mac).toEqual({ hardenedRuntime: false, identity: '-' })
    expect(mac.directories).toEqual({ output: '/out' })
    expect(baseConfig.mac.hardenedRuntime).toBe(true)

    const win = builderConfig({
      baseConfig,
      profile: 'dev',
      channelProfile: channels.profiles.dev,
      target: 'windows-amd64',
      updaterPath: 'C:\\stage\\relkit-updater.exe',
      outputDirectory: 'C:\\out'
    })
    expect(win.extraFiles).toEqual([
      { from: 'C:\\stage\\relkit-updater.exe', to: 'relkit-updater.exe' }
    ])
    expect(win.appId).toBe(channels.profiles.dev.appId)
    expect(win.mac).toMatchObject({ hardenedRuntime: true })
    expect(win.mac).not.toHaveProperty('identity')
  })

  it('requires the engine inside the payload tree', () => {
    expect(() =>
      assertEngineInTree('/definitely/missing', 'relkit-updater.exe')
    ).toThrow(/payload/)
    expect(() =>
      assertEngineInTree(join(import.meta.dirname, '..'), 'package.json')
    ).not.toThrow()
  })
})

describe('stage-relkit', () => {
  it('stages one engine per target', () => {
    expect(stagedUpdaterPath('windows-amd64')).toMatch(
      /[\\/]\.relkit[\\/]stage[\\/]windows-amd64[\\/]relkit-updater\.exe$/
    )
    expect(stagedUpdaterPath('darwin-arm64')).toMatch(
      /darwin-arm64[\\/]relkit-updater$/
    )
    expect(() => stagedUpdaterPath('linux-amd64')).toThrow(/不支持/)
  })

  it('names the host target', () => {
    expect(hostTarget('darwin', 'arm64')).toBe('darwin-arm64')
    expect(hostTarget('win32', 'x64')).toBe('windows-amd64')
    expect(hostTarget('linux', 'x64')).toBe('linux-amd64')
    expect(hostTarget('sunos', 'mips')).toBe('sunos-mips')
  })
})
