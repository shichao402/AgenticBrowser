import { describe, expect, it } from 'vitest'

import { ErrorCode } from '../src/main/updater/gen/updater/v2/updater_pb'
import {
  RELKIT_PRODUCT,
  currentReleaseIdentity,
  resolveReleaseIdentity,
  serverChannelFor
} from '../src/main/updater/identity'
import {
  MAC_SIDECAR_RELPATH,
  WINDOWS_SIDECAR_RELPATH,
  describeError,
  installLayout,
  isUpdatePlatform,
  locationProblem,
  platformSelector
} from '../src/main/updater/layout'

describe('installLayout', () => {
  it('derives the .app bundle on macOS', () => {
    const layout = installLayout(
      '/Applications/AgenticBrowser.app/Contents/MacOS/AgenticBrowser',
      'darwin'
    )
    expect(layout).toEqual({
      platform: 'darwin',
      installRoot: '/Applications/AgenticBrowser.app',
      executableRelpath: 'Contents/MacOS/AgenticBrowser',
      sidecarRelpath: MAC_SIDECAR_RELPATH,
      sidecarPath:
        '/Applications/AgenticBrowser.app/Contents/MacOS/relkit-updater',
      preserve: []
    })
  })

  it('keeps names with spaces and uses the innermost bundle', () => {
    const layout = installLayout(
      '/Users/a/Apps/Outer.app/Contents/Helpers/AgenticBrowser Dev.app/Contents/MacOS/AgenticBrowser Dev',
      'darwin'
    )
    expect(layout?.installRoot).toBe(
      '/Users/a/Apps/Outer.app/Contents/Helpers/AgenticBrowser Dev.app'
    )
    expect(layout?.executableRelpath).toBe('Contents/MacOS/AgenticBrowser Dev')
  })

  it('rejects non-bundle macOS paths', () => {
    expect(installLayout('/usr/local/bin/electron', 'darwin')).toBeNull()
    expect(installLayout('/A.app/Contents/MacOS/', 'darwin')).toBeNull()
    expect(installLayout('/A.app/Contents/MacOS/sub/bin', 'darwin')).toBeNull()
  })

  it('uses the exe directory on Windows and preserves the NSIS uninstaller', () => {
    const layout = installLayout(
      'C:\\Users\\a\\AppData\\Local\\Programs\\AgenticBrowser\\AgenticBrowser.exe',
      'win32'
    )
    expect(layout).toEqual({
      platform: 'win32',
      installRoot: 'C:\\Users\\a\\AppData\\Local\\Programs\\AgenticBrowser',
      executableRelpath: 'AgenticBrowser.exe',
      sidecarRelpath: WINDOWS_SIDECAR_RELPATH,
      sidecarPath:
        'C:\\Users\\a\\AppData\\Local\\Programs\\AgenticBrowser\\relkit-updater.exe',
      preserve: ['Uninstall AgenticBrowser.exe']
    })
  })

  it('rejects the development electron.exe and non-exe files', () => {
    expect(
      installLayout(
        'C:\\repo\\node_modules\\electron\\dist\\electron.exe',
        'win32'
      )
    ).toBeNull()
    expect(installLayout('C:\\x\\AgenticBrowser', 'win32')).toBeNull()
  })

  it('returns null on unsupported platforms', () => {
    expect(installLayout('/opt/agentic/agentic', 'linux')).toBeNull()
    expect(isUpdatePlatform('linux')).toBe(false)
    expect(isUpdatePlatform('darwin')).toBe(true)
    expect(isUpdatePlatform('win32')).toBe(true)
  })
})

describe('locationProblem', () => {
  const mac = (root: string): NonNullable<ReturnType<typeof installLayout>> => {
    const layout = installLayout(
      `${root}/Contents/MacOS/AgenticBrowser`,
      'darwin'
    )
    if (!layout) throw new Error('layout expected')
    return layout
  }
  const allWritable = (): boolean => true

  it('accepts a writable Applications install', () => {
    expect(
      locationProblem(mac('/Applications/AgenticBrowser.app'), allWritable)
    ).toBeNull()
  })

  it('rejects App Translocation and mounted images', () => {
    expect(
      locationProblem(
        mac('/private/var/folders/x/AppTranslocation/ABC/d/AgenticBrowser.app'),
        allWritable
      )
    ).toContain('隔离副本')
    expect(
      locationProblem(
        mac('/Volumes/AgenticBrowser/AgenticBrowser.app'),
        allWritable
      )
    ).toContain('安装盘')
  })

  it('needs the parent of the bundle to be writable on macOS', () => {
    const checked: string[] = []
    const problem = locationProblem(
      mac('/Applications/AgenticBrowser.app'),
      (dir) => {
        checked.push(dir)
        return false
      }
    )
    expect(checked).toEqual(['/Applications'])
    expect(problem).toContain('/Applications')
  })

  it('needs both the install root and its parent to be writable on Windows', () => {
    const layout = installLayout(
      'C:\\Program Files\\AgenticBrowser\\AgenticBrowser.exe',
      'win32'
    )
    if (!layout) throw new Error('layout expected')
    expect(locationProblem(layout, allWritable)).toBeNull()
    expect(
      locationProblem(layout, (dir) => dir !== 'C:\\Program Files')
    ).toContain('C:\\Program Files')
    expect(
      locationProblem(
        layout,
        (dir) => dir !== 'C:\\Program Files\\AgenticBrowser'
      )
    ).toContain('C:\\Program Files\\AgenticBrowser')
  })
})

describe('platformSelector', () => {
  it('maps the three published targets', () => {
    expect(platformSelector('darwin', 'arm64')).toBe('darwin-arm64')
    expect(platformSelector('darwin', 'x64')).toBe('darwin-amd64')
    expect(platformSelector('win32', 'x64')).toBe('windows-amd64')
  })

  it('returns null for targets without artifacts', () => {
    expect(platformSelector('win32', 'arm64')).toBeNull()
    expect(platformSelector('linux', 'x64')).toBeNull()
  })
})

describe('describeError', () => {
  it('translates known engine codes', () => {
    expect(describeError(ErrorCode.NETWORK, 'dial tcp')).toContain('网络')
    expect(describeError(ErrorCode.UPDATER_TOO_OLD, '')).toContain('过旧')
  })

  it('falls back to the engine message for unmapped codes', () => {
    expect(describeError(ErrorCode.SKIP_DENIED, 'mandatory')).toBe(
      '更新失败：mandatory'
    )
    expect(describeError(ErrorCode.UNSPECIFIED, '  ')).toBe('更新失败。')
  })
})

describe('release identity', () => {
  const injected = {
    bootstrap: '{"schema":"relkit.runtime-bootstrap/2"}',
    code: '42',
    version: '0.1.0+42'
  }

  it('maps profiles to server channels', () => {
    expect(serverChannelFor('release')).toBe('stable')
    expect(serverChannelFor('dev')).toBe('dev')
  })

  it('resolves a complete injection', () => {
    expect(resolveReleaseIdentity(injected, 'dev')).toEqual({
      product: RELKIT_PRODUCT,
      channel: 'dev',
      code: 42n,
      version: '0.1.0+42',
      bootstrap: injected.bootstrap
    })
  })

  it('treats any missing or malformed part as not integrated', () => {
    expect(
      resolveReleaseIdentity({ ...injected, bootstrap: ' ' }, 'release')
    ).toBeNull()
    expect(
      resolveReleaseIdentity({ ...injected, bootstrap: undefined }, 'release')
    ).toBeNull()
    expect(
      resolveReleaseIdentity({ ...injected, code: '0' }, 'release')
    ).toBeNull()
    expect(
      resolveReleaseIdentity({ ...injected, code: '07' }, 'release')
    ).toBeNull()
    expect(
      resolveReleaseIdentity({ ...injected, code: 42 }, 'release')
    ).toBeNull()
    expect(
      resolveReleaseIdentity({ ...injected, version: '' }, 'release')
    ).toBeNull()
  })

  it('is not integrated in unit tests (no build-time defines)', () => {
    expect(currentReleaseIdentity()).toBeNull()
  })
})
