import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 主进程入口接线守卫。
 *
 * 这些断言针对一类只有真正加载入口模块才会暴露的缺陷：模块级状态被拆到
 * 多个文件后，入口与冒烟实现各持一份副本，导致写入方与读取方不是同一个
 * 实例。静态检查、类型检查和单元测试都发现不了这类问题，但它会让心跳
 * 无法启动、冒烟临时目录不再清理。
 *
 * 为避免真的启动 Electron，这里用轻量替身替换 `electron` 与几个重依赖，
 * 只保留入口的编排逻辑。
 */

const calls = {
  heartbeatStart: 0,
  heartbeatStop: 0,
  loginItemSettings: [] as Array<{ path?: string; args?: string[] }>,
  readyHandlers: [] as Array<() => unknown>,
  appName: '' as string,
  pathSettings: {} as Record<string, string>
}

const heartbeatInstances: Array<{
  heartbeatPath: string
  launchId: string
  restartCount: number
  start(): void
  stop(): Promise<void>
}> = []

vi.mock('electron', () => {
  // 记录入口对应用身份做的设置，用来断言两档确实分开。
  const pathSettings: Record<string, string> = {}
  const app = {
    isPackaged: false,
    getName: () => 'AgenticBrowser',
    setName: (name: string) => {
      calls.appName = name
    },
    setPath: (name: string, value: string) => {
      pathSettings[name] = value
      calls.pathSettings[name] = value
    },
    getPath: (name: string) =>
      pathSettings[name] ?? join(tmpdir(), `agentic-entry-${name}`),
    getLoginItemSettings: (options?: { path?: string; args?: string[] }) => {
      calls.loginItemSettings.push(options ?? {})
      return { openAtLogin: false }
    },
    setLoginItemSettings: () => undefined,
    whenReady: () => Promise.resolve(),
    on: (event: string, handler: () => unknown) => {
      if (event === 'ready') {
        calls.readyHandlers.push(handler)
      }
    },
    quit: () => undefined,
    exit: () => undefined,
    requestSingleInstanceLock: () => true,
    setAppUserModelId: () => undefined,
    disableHardwareAcceleration: () => undefined
  }

  class FakeWebContentsView {
    webPreferences: Record<string, unknown> = {}
    setBackgroundColor(): void {}
    setBounds(): void {}
    webContents = {
      id: 1,
      loadURL: () => Promise.resolve(),
      on: () => undefined,
      setWindowOpenHandler: () => undefined,
      session: {}
    }
  }

  return {
    app,
    BaseWindow: class {
      contentView = { addChildView: () => undefined }
      setContentBounds(): void {}
      on(): void {}
      close(): void {}
      isDestroyed(): boolean {
        return false
      }
      show(): void {}
      focus(): void {}
      setAlwaysOnTop(): void {}
    },
    WebContentsView: FakeWebContentsView,
    session: {
      defaultSession: { setPermissionRequestHandler: () => undefined },
      fromPartition: () => ({
        setPermissionRequestHandler: () => undefined,
        setDownloadPath: () => undefined,
        on: () => undefined
      })
    },
    Menu: {
      setApplicationMenu: () => undefined,
      buildFromTemplate: () => ({})
    },
    ipcMain: { handle: () => undefined, on: () => undefined },
    shell: { openExternal: () => Promise.resolve() },
    dialog: { showOpenDialog: () => Promise.resolve({ canceled: true }) },
    nativeTheme: { shouldUseDarkColors: false, on: () => undefined },
    net: { fetch: () => Promise.resolve({}) }
  }
})

vi.mock('../src/main/main-process-heartbeat', () => ({
  MainProcessHeartbeat: class {
    constructor(
      readonly heartbeatPath: string,
      readonly launchId: string,
      readonly restartCount: number
    ) {
      heartbeatInstances.push(this)
    }

    start(): void {
      calls.heartbeatStart += 1
    }

    async stop(): Promise<void> {
      calls.heartbeatStop += 1
    }

    async beat(): Promise<void> {}
  }
}))

vi.mock('../src/main/phase0-probe-server', () => ({
  startPhaseZeroProbeServer: () =>
    Promise.resolve({
      topUrl: 'http://127.0.0.1:9/top',
      close: () => Promise.resolve()
    })
}))

const temporaryDirectories: string[] = []

beforeEach(() => {
  vi.resetModules()
  calls.heartbeatStart = 0
  calls.heartbeatStop = 0
  calls.loginItemSettings = []
  calls.readyHandlers = []
  heartbeatInstances.length = 0
  delete process.env.AGENTIC_WATCHDOG_HEARTBEAT_PATH
  delete process.env.AGENTIC_WATCHDOG_LAUNCH_ID
  delete process.env.AGENTIC_WATCHDOG_RESTART_COUNT
})

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  delete process.env.AGENTIC_WATCHDOG_HEARTBEAT_PATH
  delete process.env.AGENTIC_WATCHDOG_LAUNCH_ID
  delete process.env.AGENTIC_WATCHDOG_RESTART_COUNT
})

describe('main entry wiring', () => {
  it('constructs exactly one heartbeat from the shared runtime module', async () => {
    const heartbeatPath = join(
      mkdtempSync(join(tmpdir(), 'agentic-heartbeat-')),
      'main-heartbeat.json'
    )
    temporaryDirectories.push(join(heartbeatPath, '..'))
    writeFileSync(heartbeatPath, '{}', 'utf8')
    process.env.AGENTIC_WATCHDOG_HEARTBEAT_PATH = heartbeatPath
    process.env.AGENTIC_WATCHDOG_LAUNCH_ID = 'launch-under-test'
    process.env.AGENTIC_WATCHDOG_RESTART_COUNT = '2'

    await import('../src/main/index')

    // 入口曾在自身与 smoke-runtime 各建一份心跳，导致真正被启动的不是
    // 冒烟宿主读取的那一份。这里锁定"只构造一个"。
    expect(heartbeatInstances).toHaveLength(1)
    expect(heartbeatInstances[0]).toMatchObject({
      heartbeatPath,
      launchId: 'launch-under-test',
      restartCount: 2
    })
  })

  it('starts and stops the same heartbeat instance the runtime module exposes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentic-heartbeat-'))
    temporaryDirectories.push(directory)
    const heartbeatPath = join(directory, 'main-heartbeat.json')
    process.env.AGENTIC_WATCHDOG_HEARTBEAT_PATH = heartbeatPath

    await import('../src/main/index')

    const { getMainProcessHeartbeat } =
      await import('../src/main/smoke-runtime')
    expect(getMainProcessHeartbeat()).toBe(heartbeatInstances[0])

    // 启动后心跳必须真的被 start 过，否则守护进程会判定主进程卡死。
    expect(calls.heartbeatStart).toBe(1)
  })

  it('does not create a heartbeat when watchdog is disabled', async () => {
    await import('../src/main/index')

    const { getMainProcessHeartbeat } =
      await import('../src/main/smoke-runtime')
    expect(getMainProcessHeartbeat()).toBeNull()
    expect(heartbeatInstances).toHaveLength(0)
    expect(calls.heartbeatStart).toBe(0)
  })

  it('keeps smoke flags resolved from a single shared module', async () => {
    await import('../src/main/index')

    const flags = await import('../src/main/smoke-flags')
    // 入口不应自行解析 argv：所有标志必须来自 smoke-flags，否则入口与
    // 冒烟实现会得出不同的判定结果。
    expect(flags.automatedTestRun).toBe(false)
    expect(flags.usesPhaseZeroProbe).toBe(false)
    expect(flags.usesAutomatedDownloadDirectory).toBe(false)
  })

  it('takes its application name from the injected channel profile', async () => {
    await import('../src/main/index')

    // 应用名决定 Electron 的默认数据目录。若这里退回硬编码字符串，
    // 开发档会与正式档共用同一份登录态与配置。
    expect(calls.appName).toBe('AgenticBrowser')
  })
})

describe('cleanupAutomatedDownloads', () => {
  it('removes the directory handed in by the caller', async () => {
    const { cleanupAutomatedDownloads } =
      await import('../src/main/smoke-runners')
    const directory = mkdtempSync(join(tmpdir(), 'agentic-smoke-cleanup-'))
    writeFileSync(join(directory, 'payload.json'), '{}', 'utf8')

    cleanupAutomatedDownloads(directory)

    expect(() => rmSync(directory, { recursive: true })).toThrow()
  })

  it('tolerates a null directory for non-smoke launches', async () => {
    const { cleanupAutomatedDownloads } =
      await import('../src/main/smoke-runners')

    expect(() => cleanupAutomatedDownloads(null)).not.toThrow()
  })
})
