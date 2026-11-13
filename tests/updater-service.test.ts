import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { create } from '@bufbuild/protobuf'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UpdateStatus } from '../src/shared/contracts'
import { UpdaterError, type EngineConfig } from '../src/main/updater/engine'
import {
  ApplyAcceptedSchema,
  ApplyDisposition,
  ArtifactViewSchema,
  CheckResultSchema,
  DownloadedSchema,
  ErrorCode,
  ErrorSchema,
  FallbackRequiredSchema,
  Placement,
  ProgressSchema,
  SessionPhase,
  SessionViewSchema,
  StatusSnapshotSchema,
  ThrottledSchema,
  UpToDateSchema,
  UpdateAvailableSchema,
  type CheckResult,
  type Progress
} from '../src/main/updater/gen/updater/v2/updater_pb'
import type { ReleaseIdentity } from '../src/main/updater/identity'
import { installLayout } from '../src/main/updater/layout'
import {
  createUpdateService,
  isWritableDirectory
} from '../src/main/updater/runtime'
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  NOT_INTEGRATED_MESSAGE,
  RELEASES_URL,
  UpdateService,
  type EngineLike,
  type UpdateServiceOptions
} from '../src/main/updater/service'

const identity: ReleaseIdentity = {
  product: 'AgenticBrowser',
  channel: 'dev',
  code: 7n,
  version: '0.1.0-dev.7+7',
  bootstrap: '{"b":1}'
}

const layout = installLayout(
  '/Applications/AgenticBrowser Dev.app/Contents/MacOS/AgenticBrowser Dev',
  'darwin'
)

function checkResult(kind: CheckResult['kind']): CheckResult {
  return create(CheckResultSchema, { kind })
}

function available(
  disposition: ApplyDisposition = ApplyDisposition.INTERNAL
): CheckResult {
  return checkResult({
    case: 'updateAvailable',
    value: create(UpdateAvailableSchema, {
      planId: 'plan-1',
      version: '0.2.0-dev.9+9',
      code: 9n,
      mandatory: false,
      releaseNotesMarkdown: '- fix',
      releaseNotesUrl: '',
      artifacts: [
        create(ArtifactViewSchema, { name: 'a', size: 600n }),
        create(ArtifactViewSchema, { name: 'b', size: 400n })
      ],
      applyDisposition: disposition
    })
  })
}

const upToDate = checkResult({
  case: 'upToDate',
  value: create(UpToDateSchema, {})
})

interface FakeEngine extends EngineLike {
  status: ReturnType<typeof vi.fn<EngineLike['status']>>
  check: ReturnType<typeof vi.fn<EngineLike['check']>>
  download: ReturnType<typeof vi.fn<EngineLike['download']>>
  apply: ReturnType<typeof vi.fn<EngineLike['apply']>>
}

function fakeEngine(): FakeEngine {
  return {
    status: vi.fn<EngineLike['status']>(async () =>
      create(StatusSnapshotSchema, {})
    ),
    check: vi.fn<EngineLike['check']>(async () => upToDate),
    download: vi.fn<EngineLike['download']>(async (planId) =>
      create(DownloadedSchema, { planId })
    ),
    apply: vi.fn<EngineLike['apply']>(async () =>
      create(ApplyAcceptedSchema, { sessionId: 's1', requiresHostExit: true })
    )
  }
}

let dataDir: string
let scheduled: { callback: () => void; delayMs: number; cancelled: boolean }[]
let clock: number

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'agentic-updater-'))
  scheduled = []
  clock = 1_700_000_000_000
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

function makeService(
  engine: FakeEngine,
  overrides: Partial<UpdateServiceOptions> = {}
): {
  service: UpdateService
  quit: ReturnType<typeof vi.fn>
  configs: EngineConfig[]
} {
  const quit = vi.fn()
  const configs: EngineConfig[] = []
  const service = new UpdateService({
    identity,
    layout,
    selector: 'darwin-arm64',
    dataDir,
    displayName: 'AgenticBrowser Dev',
    fallbackVersion: '0.1.0',
    quit,
    isWritable: () => true,
    fileExists: () => true,
    createEngine: (config) => {
      configs.push(config)
      return engine
    },
    schedule: (callback, delayMs) => {
      const entry = { callback, delayMs, cancelled: false }
      scheduled.push(entry)
      return () => {
        entry.cancelled = true
      }
    },
    now: () => clock,
    ...overrides
  })
  return { service, quit, configs }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

describe('UpdateService disabled states', () => {
  it.each<[string, Partial<UpdateServiceOptions>, string]>([
    ['not integrated', { identity: null }, NOT_INTEGRATED_MESSAGE],
    ['no selector', { selector: null }, '架构'],
    ['no layout', { layout: null }, '安装位置'],
    ['missing sidecar', { fileExists: () => false }, '更新组件'],
    ['unwritable location', { isWritable: () => false }, '没有权限']
  ])('%s', async (_name, overrides, message) => {
    const engine = fakeEngine()
    const { service } = makeService(engine, overrides)
    const status = service.getStatus()
    expect(status.enabled).toBe(false)
    expect(status.phase).toBe('disabled')
    expect(status.message).toContain(message)
    expect(await service.hostMustExit()).toBe(false)
    expect((await service.check({ manual: true })).phase).toBe('disabled')
    service.start()
    expect(scheduled).toHaveLength(0)
    expect(engine.check).not.toHaveBeenCalled()
  })

  it('shows the app version when not integrated', () => {
    const { service } = makeService(fakeEngine(), { identity: null })
    expect(service.getStatus()).toMatchObject({
      channel: null,
      currentVersion: '0.1.0',
      currentCode: null
    })
  })
})

describe('UpdateService engine config', () => {
  it('passes the install facts to the engine', () => {
    const { service, configs } = makeService(fakeEngine())
    expect(service.getStatus()).toMatchObject({
      enabled: true,
      channel: 'dev',
      currentVersion: identity.version,
      currentCode: 7,
      phase: 'idle'
    })
    const config = configs[0]
    expect(config?.bin).toBe(layout?.sidecarPath)
    expect(config?.profile.expectedProduct).toBe('AgenticBrowser')
    expect(config?.profile.recovery?.links[0]?.url).toBe(RELEASES_URL)
    expect(config?.runtime.channel).toBe('dev')
    expect(config?.runtime.currentCode).toBe(7n)
    expect(config?.runtime.clientSelectors).toEqual({
      'os-arch': 'darwin-arm64'
    })
    expect(config?.runtime.install).toMatchObject({
      placement: Placement.IN_PLACE,
      installRoot: '/Applications/AgenticBrowser Dev.app',
      executableRelpath: 'Contents/MacOS/AgenticBrowser Dev',
      sidecarRelpath: 'Contents/MacOS/relkit-updater',
      preserve: [],
      relaunch: true,
      displayName: 'AgenticBrowser Dev'
    })
  })
})

describe('UpdateService.hostMustExit', () => {
  it('follows the engine and lets the app start when the engine fails', async () => {
    const engine = fakeEngine()
    const log = vi.fn()
    const { service } = makeService(engine, { log })
    engine.status.mockResolvedValueOnce(
      create(StatusSnapshotSchema, { hostMustExit: true })
    )
    expect(await service.hostMustExit()).toBe(true)
    engine.status.mockRejectedValueOnce(new Error('gone'))
    expect(await service.hostMustExit()).toBe(false)
    expect(log).toHaveBeenCalled()
  })
})

describe('UpdateService.check', () => {
  it('reports up to date with a timestamp', async () => {
    const engine = fakeEngine()
    const { service } = makeService(engine)
    const seen: UpdateStatus['phase'][] = []
    const unsubscribe = service.subscribe((status) => seen.push(status.phase))
    const status = await service.check({ manual: true })
    unsubscribe()
    expect(engine.check).toHaveBeenCalledWith(true)
    expect(seen).toEqual(['checking', 'up-to-date'])
    expect(status.checkedAt).toBe(new Date(clock).toISOString())
    expect(status.message).toBeNull()
  })

  it('mentions a yanked current version', async () => {
    const engine = fakeEngine()
    engine.check.mockResolvedValueOnce(
      checkResult({
        case: 'upToDate',
        value: create(UpToDateSchema, { currentIsYanked: true })
      })
    )
    const { service } = makeService(engine)
    expect((await service.check({ manual: false })).message).toContain('撤回')
  })

  it('exposes an internal offer', async () => {
    const engine = fakeEngine()
    engine.check.mockResolvedValueOnce(available())
    const { service } = makeService(engine)
    const status = await service.check({ manual: false })
    expect(status.phase).toBe('available')
    expect(status.available).toEqual({
      version: '0.2.0-dev.9+9',
      code: 9,
      mandatory: false,
      inApp: true,
      fullInstall: false,
      releaseNotes: '- fix',
      releaseNotesUrl: null,
      sizeBytes: 1000
    })
    expect(status.manualUrl).toBeNull()
  })

  it('keeps full-install handoffs in the app', async () => {
    const engine = fakeEngine()
    engine.check.mockResolvedValueOnce(available(ApplyDisposition.FULL_INSTALL))
    const { service } = makeService(engine)
    const status = await service.check({ manual: true })
    expect(status.available).toMatchObject({ inApp: true, fullInstall: true })
    expect(status.manualUrl).toBeNull()
    expect((await service.download()).phase).toBe('downloaded')
  })

  it('points offers without a disposition to the release page', async () => {
    const engine = fakeEngine()
    engine.check.mockResolvedValueOnce(available(ApplyDisposition.UNSPECIFIED))
    const { service } = makeService(engine)
    const status = await service.check({ manual: true })
    expect(status.available?.inApp).toBe(false)
    expect(status.manualUrl).toBe(RELEASES_URL)
    // 外部交付的版本不能在应用内下载。
    expect((await service.download()).phase).toBe('available')
    expect(engine.download).not.toHaveBeenCalled()
  })

  it('handles fallback with and without a server URL', async () => {
    const engine = fakeEngine()
    engine.check
      .mockResolvedValueOnce(
        checkResult({
          case: 'fallbackRequired',
          value: create(FallbackRequiredSchema, {
            manualUrl: 'https://x/dl',
            message: '太旧'
          })
        })
      )
      .mockResolvedValueOnce(
        checkResult({
          case: 'fallbackRequired',
          value: create(FallbackRequiredSchema, {})
        })
      )
    const { service } = makeService(engine)
    expect(await service.check({ manual: true })).toMatchObject({
      phase: 'fallback',
      message: '太旧',
      manualUrl: 'https://x/dl'
    })
    expect(await service.check({ manual: true })).toMatchObject({
      phase: 'fallback',
      manualUrl: RELEASES_URL
    })
  })

  it('restores the previous phase when throttled', async () => {
    const engine = fakeEngine()
    engine.check.mockResolvedValue(
      checkResult({ case: 'throttled', value: create(ThrottledSchema, {}) })
    )
    const { service } = makeService(engine)
    const automatic = await service.check({ manual: false })
    expect(automatic.phase).toBe('idle')
    expect(automatic.message).toBeNull()
    const manual = await service.check({ manual: true })
    expect(manual.phase).toBe('idle')
    expect(manual.message).toContain('频繁')
  })

  it('reports unknown results and engine errors', async () => {
    const engine = fakeEngine()
    engine.check
      .mockResolvedValueOnce(create(CheckResultSchema, {}))
      .mockRejectedValueOnce(new UpdaterError(ErrorCode.NETWORK, 'offline'))
      .mockRejectedValueOnce(new Error('weird'))
    const { service } = makeService(engine)
    expect((await service.check({ manual: true })).message).toContain(
      '无法识别'
    )
    expect(await service.check({ manual: true })).toMatchObject({
      phase: 'error',
      available: null
    })
    expect(service.getStatus().message).toContain('网络')
    expect((await service.check({ manual: true })).message).toBe(
      '更新失败：weird'
    )
  })

  it('skips automatic checks while an offer is pending and overlapping checks', async () => {
    const engine = fakeEngine()
    engine.check.mockResolvedValueOnce(available())
    const { service } = makeService(engine)
    await service.check({ manual: false })
    await service.check({ manual: false })
    expect(engine.check).toHaveBeenCalledTimes(1)

    let release: (result: CheckResult) => void = () => undefined
    engine.check.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      })
    )
    const first = service.check({ manual: true })
    const second = await service.check({ manual: true })
    expect(second.phase).toBe('checking')
    release(upToDate)
    expect((await first).phase).toBe('up-to-date')
    expect(engine.check).toHaveBeenCalledTimes(2)
  })
})

describe('UpdateService download and install', () => {
  async function offered(
    engine: FakeEngine
  ): Promise<ReturnType<typeof makeService>> {
    engine.check.mockResolvedValueOnce(available())
    const made = makeService(engine)
    await made.service.check({ manual: true })
    return made
  }

  it('ignores download and install without a plan', async () => {
    const engine = fakeEngine()
    const { service } = makeService(engine)
    expect((await service.download()).phase).toBe('idle')
    expect((await service.install()).phase).toBe('idle')
    expect(engine.download).not.toHaveBeenCalled()
    expect(engine.apply).not.toHaveBeenCalled()
  })

  it('throttles progress but always publishes completion', async () => {
    const engine = fakeEngine()
    const { service } = await offered(engine)
    engine.download.mockImplementationOnce(async (planId, onProgress) => {
      const tick = (received: bigint, advance: number): void => {
        clock += advance
        onProgress?.(
          create(ProgressSchema, {
            bytesReceived: received,
            bytesTotal: 1000n,
            bytesPerSecond: 100n
          }) as Progress
        )
      }
      tick(100n, 1000)
      tick(200n, 10)
      tick(300n, 300)
      tick(1000n, 1)
      return create(DownloadedSchema, { planId })
    })
    const progress: (number | undefined)[] = []
    service.subscribe((status) => progress.push(status.progress?.received))
    const status = await service.download()
    expect(engine.download).toHaveBeenCalledWith('plan-1', expect.any(Function))
    expect(progress).toEqual([0, 100, 300, 1000, undefined])
    expect(status.phase).toBe('downloaded')
    expect(status.progress).toBeNull()
    // 已下载时不重复下载。
    await service.download()
    expect(engine.download).toHaveBeenCalledTimes(1)
  })

  it('offers a retry after a failed download', async () => {
    const engine = fakeEngine()
    const { service } = await offered(engine)
    engine.download.mockRejectedValueOnce(
      new UpdaterError(ErrorCode.DISK, 'full')
    )
    const failed = await service.download()
    expect(failed.phase).toBe('error')
    expect(failed.available?.inApp).toBe(true)
    expect((await service.download()).phase).toBe('downloaded')
  })

  it('stops scheduling and quits when the engine takes over', async () => {
    const engine = fakeEngine()
    const { service, quit } = await offered(engine)
    service.start()
    await service.download()
    const status = await service.install()
    expect(engine.apply).toHaveBeenCalledWith('plan-1')
    expect(status.phase).toBe('applying')
    expect(quit).toHaveBeenCalledTimes(1)
    expect(scheduled[0]?.cancelled).toBe(true)
  })

  it('stays up when no host exit is required', async () => {
    const engine = fakeEngine()
    engine.apply.mockResolvedValueOnce(
      create(ApplyAcceptedSchema, { sessionId: 's', requiresHostExit: false })
    )
    const { service, quit } = await offered(engine)
    await service.download()
    expect((await service.install()).message).toContain('重启应用后生效')
    expect(quit).not.toHaveBeenCalled()
  })

  it('reports apply failures', async () => {
    const engine = fakeEngine()
    engine.apply.mockRejectedValueOnce(
      new UpdaterError(ErrorCode.OCCUPIED, 'busy')
    )
    const { service, quit } = await offered(engine)
    await service.download()
    const status = await service.install()
    expect(status.phase).toBe('error')
    expect(status.message).toContain('占用')
    expect(quit).not.toHaveBeenCalled()
  })
})

describe('UpdateService scheduling', () => {
  it('checks after the first delay and then on the interval', async () => {
    const engine = fakeEngine()
    const { service } = makeService(engine)
    service.start()
    service.start()
    expect(scheduled.map((entry) => entry.delayMs)).toEqual([
      FIRST_CHECK_DELAY_MS
    ])
    scheduled[0]?.callback()
    await flush()
    expect(engine.check).toHaveBeenCalledWith(false)
    expect(scheduled.map((entry) => entry.delayMs)).toEqual([
      FIRST_CHECK_DELAY_MS,
      CHECK_INTERVAL_MS
    ])
    service.stop()
    expect(scheduled[1]?.cancelled).toBe(true)
  })

  it('does not reschedule after stop', async () => {
    const engine = fakeEngine()
    const { service } = makeService(engine)
    service.start()
    service.stop()
    scheduled[0]?.callback()
    await flush()
    expect(scheduled).toHaveLength(1)
  })
})

describe('UpdateService.reportLastSession', () => {
  function session(phase: SessionPhase, id = 'sess-1') {
    return create(StatusSnapshotSchema, {
      activeSession: create(SessionViewSchema, {
        sessionId: id,
        phase,
        error: create(ErrorSchema, { code: ErrorCode.DISK, message: 'full' })
      })
    })
  }

  it('reports a rollback once per session', async () => {
    const engine = fakeEngine()
    engine.status.mockResolvedValue(session(SessionPhase.ROLLED_BACK))
    const { service } = makeService(engine)
    await service.reportLastSession()
    expect(service.getStatus()).toMatchObject({
      phase: 'error',
      manualUrl: RELEASES_URL
    })
    expect(service.getStatus().message).toContain('已回滚')
    expect(readFileSync(join(dataDir, 'reported-session'), 'utf8')).toBe(
      'sess-1'
    )

    const again = makeService(engine).service
    await again.reportLastSession()
    expect(again.getStatus().phase).toBe('idle')
  })

  it('reports sessions needing attention', async () => {
    const engine = fakeEngine()
    engine.status.mockResolvedValue(
      session(SessionPhase.NEEDS_ATTENTION, 'sess-2')
    )
    const { service } = makeService(engine)
    await service.reportLastSession()
    expect(service.getStatus().message).toContain('人工处理')
  })

  it('ignores healthy, missing or unreadable sessions', async () => {
    const engine = fakeEngine()
    const log = vi.fn()
    const { service } = makeService(engine, { log })
    await service.reportLastSession()
    engine.status.mockResolvedValueOnce(session(SessionPhase.UNSPECIFIED))
    await service.reportLastSession()
    engine.status.mockRejectedValueOnce(new Error('nope'))
    await service.reportLastSession()
    expect(service.getStatus().phase).toBe('idle')
    expect(log).toHaveBeenCalled()
  })
})

describe('createUpdateService', () => {
  it('stays disabled outside a CI release build', () => {
    const service = createUpdateService({
      executablePath:
        '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
      platform: 'darwin',
      arch: 'arm64',
      userDataPath: dataDir,
      appVersion: '0.1.0',
      quit: () => undefined,
      log: () => undefined
    })
    expect(service.getStatus()).toMatchObject({
      enabled: false,
      phase: 'disabled',
      message: NOT_INTEGRATED_MESSAGE,
      currentVersion: '0.1.0'
    })
  })

  it('checks directory writability', () => {
    expect(isWritableDirectory(dataDir)).toBe(true)
    expect(isWritableDirectory(join(dataDir, 'missing'))).toBe(false)
  })
})
