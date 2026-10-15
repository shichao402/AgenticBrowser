import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BaseWindow, ipcMain, WebContentsView } from 'electron'

import {
  IPC_CHANNELS,
  type BrowserEvent,
  type CapabilitySettings,
  type MonitorSnapshot,
  type ReloadOptions
} from '../shared/contracts'
import { writeJsonAtomic } from './atomic-file'
import { BrowserTabManager } from './browser-tab-manager'
import {
  CapabilityStore,
  DEFAULT_CAPABILITIES
} from './capability-store'
import {
  BrowserCheckpointStore,
  type BrowserCheckpoint
} from './checkpoint-store'
import { MainProcessHeartbeat } from './main-process-heartbeat'
import {
  startPhaseZeroProbeServer,
  type PhaseZeroProbeServer
} from './phase0-probe-server'
import { StructuredEventLog } from './structured-event-log'

const managedUserDataPath = process.env.AGENTIC_USER_DATA_PATH
if (managedUserDataPath) {
  mkdirSync(managedUserDataPath, { recursive: true })
  app.setPath('userData', managedUserDataPath)
}

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const SIDEBAR_WIDTH = 320
const TOOLBAR_HEIGHT = 104
const MIN_PAGE_SIZE = 240

let mainWindow: BaseWindow | null = null
const smokeTest = process.argv.includes('--smoke-test')
const recoverySmokeTest = process.argv.includes('--recovery-smoke-test')
const watchdogSmokeChild = process.argv.includes('--watchdog-smoke-child')
const smokeResultPath = join(process.cwd(), 'phase0-smoke-result.json')
const recoverySmokeResultPath = join(
  process.cwd(),
  'phase1-recovery-smoke-result.json'
)
let phaseZeroProbe: PhaseZeroProbeServer | null = null
let automatedDownloadDirectory: string | null = null
const watchdogRestartCount = parseNonNegativeInteger(
  process.env.AGENTIC_WATCHDOG_RESTART_COUNT
)
const mainProcessHeartbeat = process.env.AGENTIC_WATCHDOG_HEARTBEAT_PATH
  ? new MainProcessHeartbeat(
      process.env.AGENTIC_WATCHDOG_HEARTBEAT_PATH,
      process.env.AGENTIC_WATCHDOG_LAUNCH_ID ?? `unmanaged-${process.pid}`,
      watchdogRestartCount
    )
  : null
mainProcessHeartbeat?.start()

function writeSmokeResult(result: unknown): void {
  if (smokeTest) {
    writeFileSync(smokeResultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  }
}

function writeRecoverySmokeResult(result: unknown): void {
  if (recoverySmokeTest) {
    writeFileSync(
      recoverySmokeResultPath,
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8'
    )
  }
}

interface MainWindowRuntime {
  window: BaseWindow
  shellView: WebContentsView
  supervisor: BrowserTabManager
  events: BrowserEvent[]
  getEventCount(): number
}

interface CreateMainWindowOptions {
  show?: boolean
  initialUrl?: string
  phaseZeroProbe?: boolean
  profileId?: string
  checkpointStore?: BrowserCheckpointStore
  eventLog?: StructuredEventLog
  capabilityStore?: CapabilityStore
  capabilities?: CapabilitySettings
  downloadDirectory?: string
}

async function createMainWindow(options: CreateMainWindowOptions = {}): Promise<MainWindowRuntime> {
  const {
    show = true,
    initialUrl,
    phaseZeroProbe = false,
    profileId,
    checkpointStore,
    eventLog,
    capabilityStore,
    capabilities,
    downloadDirectory
  } = options
  const window = new BaseWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'AgenticBrowser',
    show: false
  })

  const shellView = new WebContentsView({
    webPreferences: {
      preload: join(currentDirectory, '../preload/shell.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  window.contentView.addChildView(shellView)
  const events: BrowserEvent[] = []
  let eventCount = 0

  const publish = (event: BrowserEvent): void => {
    eventCount += 1
    events.push(event)
    if (events.length > 500) {
      events.shift()
    }
    void eventLog?.append(event).catch((error: unknown) => {
      console.error('写入结构化事件日志失败', error)
    })
    if (!shellView.webContents.isDestroyed()) {
      shellView.webContents.send(IPC_CHANNELS.browserEvent, event)
    }
  }

  const supervisor = new BrowserTabManager(window, publish, {
    ...(initialUrl ? { initialUrl } : {}),
    strategyPreloadPath: join(currentDirectory, '../preload/strategy-bootstrap.cjs'),
    phaseZeroProbe,
    healthMonitoring: !phaseZeroProbe,
    recoveryEnabled: !phaseZeroProbe,
    ...(capabilities ? { capabilities } : {}),
    ...(downloadDirectory ? { downloadDirectory } : {}),
    ...(profileId ? { profileId } : {}),
    ...(checkpointStore ? { checkpointStore } : {})
  })

  const layout = (): void => {
    const { width, height } = window.getContentBounds()
    shellView.setBounds({ x: 0, y: 0, width, height })
    supervisor.setBounds({
      x: SIDEBAR_WIDTH,
      y: TOOLBAR_HEIGHT,
      width: Math.max(MIN_PAGE_SIZE, width - SIDEBAR_WIDTH),
      height: Math.max(MIN_PAGE_SIZE, height - TOOLBAR_HEIGHT)
    })
  }

  const assertTrustedSender = (senderId: number): void => {
    if (senderId !== shellView.webContents.id) {
      throw new Error('拒绝来自非 BrowserShell 的 IPC 调用')
    }
  }

  ipcMain.handle(IPC_CHANNELS.getSnapshot, (event) => {
    assertTrustedSender(event.sender.id)
    return supervisor.getSnapshot()
  })

  ipcMain.handle(IPC_CHANNELS.getMonitorSnapshot, (event) => {
    assertTrustedSender(event.sender.id)
    return collectMonitorSnapshot(supervisor, eventCount)
  })

  ipcMain.handle(IPC_CHANNELS.getCapabilities, (event) => {
    assertTrustedSender(event.sender.id)
    return supervisor.getCapabilities()
  })

  ipcMain.handle(IPC_CHANNELS.setCapabilities, async (event, value: unknown) => {
    assertTrustedSender(event.sender.id)
    if (!capabilityStore) {
      throw new Error('Capability Store 当前不可用')
    }
    const settings = await capabilityStore.write(value)
    return supervisor.setCapabilities(settings)
  })

  ipcMain.handle(IPC_CHANNELS.listTabs, (event) => {
    assertTrustedSender(event.sender.id)
    return supervisor.listTabs()
  })

  ipcMain.handle(IPC_CHANNELS.createTab, (event, url: unknown) => {
    assertTrustedSender(event.sender.id)
    if (url !== undefined && typeof url !== 'string') {
      throw new TypeError('新标签页 URL 必须是字符串')
    }
    return supervisor.createTab(url)
  })

  ipcMain.handle(IPC_CHANNELS.switchTab, (event, tabId: unknown) => {
    assertTrustedSender(event.sender.id)
    if (typeof tabId !== 'string') {
      throw new TypeError('标签页 ID 必须是字符串')
    }
    return supervisor.switchTab(tabId)
  })

  ipcMain.handle(IPC_CHANNELS.closeTab, (event, tabId: unknown) => {
    assertTrustedSender(event.sender.id)
    if (typeof tabId !== 'string') {
      throw new TypeError('标签页 ID 必须是字符串')
    }
    return supervisor.closeTab(tabId)
  })

  ipcMain.handle(IPC_CHANNELS.navigate, async (event, url: unknown) => {
    assertTrustedSender(event.sender.id)
    if (typeof url !== 'string') {
      throw new TypeError('导航 URL 必须是字符串')
    }

    return supervisor.navigate(url)
  })

  ipcMain.handle(IPC_CHANNELS.reload, (event, options: unknown) => {
    assertTrustedSender(event.sender.id)
    const normalized: ReloadOptions = {
      ignoreCache:
        typeof options === 'object' &&
        options !== null &&
        'ignoreCache' in options &&
        options.ignoreCache === true
    }
    return supervisor.reload(normalized)
  })

  window.on('resize', layout)
  window.on('closed', () => {
    supervisor.dispose(true)
    void eventLog?.flush()
    const removeIpcHandlers = (): void => {
      ipcMain.removeHandler(IPC_CHANNELS.getSnapshot)
      ipcMain.removeHandler(IPC_CHANNELS.getMonitorSnapshot)
      ipcMain.removeHandler(IPC_CHANNELS.getCapabilities)
      ipcMain.removeHandler(IPC_CHANNELS.setCapabilities)
      ipcMain.removeHandler(IPC_CHANNELS.listTabs)
      ipcMain.removeHandler(IPC_CHANNELS.createTab)
      ipcMain.removeHandler(IPC_CHANNELS.switchTab)
      ipcMain.removeHandler(IPC_CHANNELS.closeTab)
      ipcMain.removeHandler(IPC_CHANNELS.navigate)
      ipcMain.removeHandler(IPC_CHANNELS.reload)
    }

    if (shellView.webContents.isDestroyed()) {
      removeIpcHandlers()
    } else {
      shellView.webContents.once('destroyed', removeIpcHandlers)
      shellView.webContents.close()
    }

    if (mainWindow === window) {
      mainWindow = null
    }
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    await shellView.webContents.loadURL(rendererUrl)
  } else {
    await shellView.webContents.loadFile(join(currentDirectory, '../renderer/index.html'))
  }

  layout()
  await supervisor.start()
  if (show) {
    window.show()
  }
  mainWindow = window

  return {
    window,
    shellView,
    supervisor,
    events,
    getEventCount: () => eventCount
  }
}

function collectMonitorSnapshot(
  supervisor: BrowserTabManager,
  browserEventCount: number
): MonitorSnapshot {
  const processes = app.getAppMetrics().map((metric) => ({
    pid: metric.pid,
    type: metric.type,
    cpuPercent: metric.cpu.percentCPUUsage,
    workingSetBytes: metric.memory.workingSetSize * 1024
  }))

  return {
    generatedAt: new Date().toISOString(),
    browser: supervisor.getSnapshot(),
    browserEventCount,
    activePageCount: supervisor.listTabs().length,
    activeStrategyCount: 0,
    totalCpuPercent: processes.reduce(
      (total, metric) => total + metric.cpuPercent,
      0
    ),
    totalWorkingSetBytes: processes.reduce(
      (total, metric) => total + metric.workingSetBytes,
      0
    ),
    processes,
    downloads: supervisor.getDownloadSummary()
  }
}

function createCheckpointStore(): BrowserCheckpointStore | undefined {
  if (smokeTest || recoverySmokeTest) {
    return undefined
  }

  return new BrowserCheckpointStore(
    process.env.AGENTIC_CHECKPOINT_PATH ??
      join(app.getPath('userData'), 'runtime', 'browser-checkpoint.json')
  )
}

async function runWatchdogSmokeChild(
  runtime: MainWindowRuntime,
  restoredCheckpoint: BrowserCheckpoint | null,
  requestedUrl: string | undefined
): Promise<void> {
  const resultPath = process.env.AGENTIC_WATCHDOG_CHILD_RESULT_PATH
  if (!resultPath) {
    throw new Error('Watchdog smoke 缺少结果文件路径')
  }

  const checkpoint = await runtime.supervisor.flushCheckpoint(
    watchdogRestartCount === 0 ? 'watchdog-smoke-ready' : 'watchdog-smoke-restored'
  )
  const snapshot = runtime.supervisor.getSnapshot()
  const profileCookiePresent =
    await runtime.supervisor.hasProfileCookie('agentic_watchdog_session')
  const targetUrl = restoredCheckpoint?.url ?? requestedUrl
  const passed =
    watchdogRestartCount > 0 &&
    restoredCheckpoint !== null &&
    checkpoint !== null &&
    targetUrl !== undefined &&
    snapshot.url === targetUrl &&
    checkpoint.url === targetUrl &&
    profileCookiePresent
  const result = {
    ready: true,
    passed: watchdogRestartCount === 0 ? null : passed,
    pid: process.pid,
    restartCount: watchdogRestartCount,
    restoredFromCheckpoint: restoredCheckpoint !== null,
    restoredCheckpoint,
    checkpoint,
    snapshot,
    profileCookiePresent,
    heartbeatActive: mainProcessHeartbeat !== null
  }

  await writeJsonAtomic(resultPath, result)
  console.log(`AGENTIC_BROWSER_WATCHDOG_CHILD ${JSON.stringify(result)}`)

  if (watchdogRestartCount > 0) {
    runtime.window.close()
    await mainProcessHeartbeat?.stop()
    app.exit(passed ? 0 : 1)
  }
}

async function runRecoverySmoke(
  runtime: MainWindowRuntime,
  probe: PhaseZeroProbeServer
): Promise<Record<string, unknown>> {
  const popupUrl = new URL('/popup', probe.topUrl).toString()
  const initialTabs = runtime.supervisor.listTabs()
  const tabsAfterCreate = await runtime.supervisor.createTab(popupUrl)
  const firstTab = initialTabs[0]
  const secondTab = tabsAfterCreate.find((tab) => tab.active)
  if (!firstTab || !secondTab || firstTab.id === secondTab.id) {
    throw new Error('多标签创建结果无效')
  }
  const tabsAfterOwnerClose = runtime.supervisor.closeTab(firstTab.id)
  const multiTabPassed =
    tabsAfterCreate.length === 2 &&
    tabsAfterOwnerClose.length === 1 &&
    tabsAfterOwnerClose[0]?.id === secondTab.id &&
    tabsAfterOwnerClose[0]?.active === true

  await runtime.supervisor.triggerPopup(popupUrl)
  await waitUntil(
    () => runtime.events.some((event) => event.type === 'popup-blocked'),
    2_000
  )
  const popupBlocked = runtime.events.some(
    (event) => event.type === 'popup-blocked'
  )

  runtime.supervisor.setCapabilities({
    ...runtime.supervisor.getCapabilities(),
    popups: true
  })
  await runtime.supervisor.triggerPopup(popupUrl)
  await waitUntil(
    () => runtime.supervisor.getSnapshot().url === popupUrl,
    3_000
  )
  const popupRouted =
    runtime.supervisor.getSnapshot().url === popupUrl &&
    runtime.events.some((event) => event.type === 'popup-routed')

  const downloadUrl = new URL('/sample.mp3', probe.topUrl).toString()
  runtime.supervisor.requestDownload(downloadUrl)
  await waitUntil(
    () => runtime.supervisor.getDownloadSummary().completed === 1,
    5_000
  )
  const allowedDownload = runtime.supervisor.getDownloadSummary()
  runtime.supervisor.setCapabilities({
    ...runtime.supervisor.getCapabilities(),
    downloads: false
  })
  runtime.supervisor.requestDownload(`${downloadUrl}?blocked=1`)
  await waitUntil(
    () => runtime.events.some((event) => event.type === 'download-blocked'),
    3_000
  )
  const downloadBlocked = runtime.events.some(
    (event) => event.type === 'download-blocked'
  )

  let navigationRejected = false
  const failedUrl = new URL('/disconnect', probe.topUrl).toString()
  try {
    await runtime.supervisor.navigate(failedUrl)
  } catch {
    navigationRejected = true
  }

  const startedAt = Date.now()
  while (
    runtime.supervisor.getSnapshot().recovery.status !== 'circuit-open' &&
    Date.now() - startedAt < 10_000
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  const snapshot = runtime.supervisor.getSnapshot()
  const recoveryActions = runtime.events
    .filter((event) => event.type === 'recovery-started')
    .map((event) => event.detail?.split(';')[0] ?? '')
  const expectedActions = [
    'reload',
    'reload-ignore-cache',
    'clear-cache-and-reload',
    'recreate-view'
  ]
  const passed =
    multiTabPassed &&
    popupBlocked &&
    popupRouted &&
    allowedDownload.completed === 1 &&
    allowedDownload.receivedBytes === 4096 &&
    downloadBlocked &&
    navigationRejected &&
    snapshot.recovery.status === 'circuit-open' &&
    snapshot.recovery.attemptsInWindow === 4 &&
    snapshot.responsive === false &&
    snapshot.generation >= 2 &&
    expectedActions.every(
      (action, index) => recoveryActions[index] === action
    ) &&
    runtime.events.some((event) => event.type === 'circuit-open')

  return {
    passed,
    navigationRejected,
    multiTabPassed,
    tabsAfterCreate,
    tabsAfterOwnerClose,
    popupBlocked,
    popupRouted,
    allowedDownload,
    downloadBlocked,
    failedUrl,
    elapsedMs: Date.now() - startedAt,
    recoveryActions,
    snapshot,
    events: runtime.events
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number
): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`等待条件超过 ${timeoutMs} ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function parseNonNegativeInteger(value: string | undefined): number {
  if (!value) {
    return 0
  }

  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
}

function cleanupAutomatedDownloads(): void {
  if (automatedDownloadDirectory) {
    rmSync(automatedDownloadDirectory, { recursive: true, force: true })
    automatedDownloadDirectory = null
  }
}

app.whenReady().then(async () => {
  app.setAppUserModelId('com.firoyang.agenticbrowser')
  const checkpointStore = createCheckpointStore()
  const eventLog =
    smokeTest || recoverySmokeTest
      ? undefined
      : new StructuredEventLog(
          join(app.getPath('userData'), 'logs', 'browser-events.jsonl')
        )
  const restoredCheckpoint = checkpointStore
    ? await checkpointStore.read()
    : null
  const profileId = restoredCheckpoint?.profileId ?? 'profile-default'
  const capabilityStore = new CapabilityStore(
    join(app.getPath('userData'), 'config', 'capabilities.json')
  )
  const capabilities =
    smokeTest || recoverySmokeTest
      ? { ...DEFAULT_CAPABILITIES }
      : await capabilityStore.read()
  automatedDownloadDirectory =
    smokeTest || recoverySmokeTest
      ? join(app.getPath('temp'), `agentic-browser-smoke-${process.pid}`)
      : null
  phaseZeroProbe =
    smokeTest || recoverySmokeTest ? await startPhaseZeroProbeServer() : null
  const watchdogSmokeUrl = process.env.AGENTIC_WATCHDOG_SMOKE_URL
  if (watchdogSmokeChild && !watchdogSmokeUrl && !restoredCheckpoint) {
    throw new Error('Watchdog smoke 缺少初始 URL')
  }

  const initialUrl =
    phaseZeroProbe?.topUrl ?? restoredCheckpoint?.url ?? watchdogSmokeUrl
  const runtime = await createMainWindow({
    show: !watchdogSmokeChild && !recoverySmokeTest,
    phaseZeroProbe: smokeTest,
    ...(initialUrl ? { initialUrl } : {}),
    profileId,
    ...(checkpointStore ? { checkpointStore } : {}),
    ...(eventLog ? { eventLog } : {}),
    capabilityStore,
    capabilities,
    downloadDirectory:
      automatedDownloadDirectory ??
      join(app.getPath('userData'), 'downloads', profileId)
  })

  if (smokeTest) {
    runtime.window.setAlwaysOnTop(true)
    runtime.window.show()
    runtime.window.focus()
    if (!phaseZeroProbe) {
      throw new Error('Phase 0 probe server 未启动')
    }

    const beforeCrash = await runtime.supervisor.collectDiagnostics(runtime.shellView.webContents.id)
    const framesBeforeCrash = await runtime.supervisor.collectFrameDiagnostics()
    const profileCookieBeforeCrash =
      await runtime.supervisor.hasProfileCookie('agentic_phase0_session')
    const capture = await runtime.supervisor.benchmarkCapture()
    const interactionDuringCapture =
      await runtime.supervisor.benchmarkInteractionDuringCapture()
    const multiViewCapture = await runtime.supervisor.benchmarkMultiViewCapture()
    const heartbeatStall = await runtime.supervisor.probeHeartbeatStall()
    await runtime.supervisor.forceCrashAndWait()
    const afterCrash = await runtime.supervisor.collectDiagnostics(runtime.shellView.webContents.id)
    const framesAfterCrash = await runtime.supervisor.collectFrameDiagnostics()
    const profileCookieAfterCrash =
      await runtime.supervisor.hasProfileCookie('agentic_phase0_session')
    let failedNavigationRejected = false
    try {
      await runtime.supervisor.navigate(new URL('/disconnect', phaseZeroProbe.topUrl).toString())
    } catch {
      failedNavigationRejected = true
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
    const mainProcessId = framesBeforeCrash.find((frame) => frame.isMainFrame)?.processId
    const expectedLabels = new Set(['top', 'same-origin', 'cross-origin'])
    const injectedBeforeCrash = framesBeforeCrash.filter(
      (frame) =>
        frame.observation?.probeVisibleAtInline === true &&
        frame.observation.preloadReadyState === 'loading' &&
        expectedLabels.has(frame.observation.label)
    )
    const injectedAfterCrash = framesAfterCrash.filter(
      (frame) =>
        frame.observation?.probeVisibleAtInline === true &&
        frame.observation.preloadReadyState === 'loading' &&
        expectedLabels.has(frame.observation.label)
    )
    const oopifObserved = framesBeforeCrash.some(
      (frame) => !frame.isMainFrame && frame.processId !== mainProcessId
    )
    const observedEventTypes = new Set(runtime.events.map((event) => event.type))
    const expectedEventTypes: BrowserEvent['type'][] = [
      'created',
      'navigation-started',
      'navigation-finished',
      'load-started',
      'load-finished',
      'load-failed',
      'renderer-gone',
      'recreated'
    ]
    const passed =
      beforeCrash.distinctWebContents &&
      beforeCrash.preferences.sandbox &&
      beforeCrash.preferences.contextIsolation &&
      !beforeCrash.preferences.nodeIntegration &&
      beforeCrash.preferences.nodeIntegrationInSubFrames &&
      !beforeCrash.pageWorld.hasNodeProcess &&
      !beforeCrash.pageWorld.hasRequire &&
      !beforeCrash.pageWorld.hasBrowserShellBridge &&
      beforeCrash.strategyPreloadRegistered &&
      injectedBeforeCrash.length === expectedLabels.size &&
      injectedAfterCrash.length === expectedLabels.size &&
      oopifObserved &&
      profileCookieBeforeCrash &&
      profileCookieAfterCrash &&
      capture.emptyFrames === 0 &&
      capture.achievedFps >= 9.5 &&
      capture.ring.frameCount === 10 &&
      capture.ring.byteLength <= 1024 * 1024 &&
      capture.ring.evictedFrames === 10 &&
      interactionDuringCapture.captureFps >= 9.5 &&
      interactionDuringCapture.duringCapture.p95Ms < 100 &&
      interactionDuringCapture.p95DeltaMs < 100 &&
      multiViewCapture.distinctWebContents &&
      multiViewCapture.auxiliaryResponsive &&
      multiViewCapture.auxiliaryTickAdvanced &&
      multiViewCapture.emptyFrames === 0 &&
      multiViewCapture.achievedFps >= 9 &&
      heartbeatStall.stallDetected &&
      heartbeatStall.recovered &&
      heartbeatStall.frozenEvidence.frozen &&
      heartbeatStall.frozenEvidence.frameCount === 3 &&
      heartbeatStall.frozenEvidence.byteLength > 0 &&
      failedNavigationRejected &&
      expectedEventTypes.every((eventType) => observedEventTypes.has(eventType)) &&
      afterCrash.generation > beforeCrash.generation

    const result = {
      passed,
      beforeCrash,
      afterCrash,
      framesBeforeCrash,
      framesAfterCrash,
      oopifObserved,
      profileCookieBeforeCrash,
      profileCookieAfterCrash,
      failedNavigationRejected,
      observedEventTypes: [...observedEventTypes],
      heartbeatStall,
      capture,
      interactionDuringCapture,
      multiViewCapture
    }
    writeSmokeResult(result)
    console.log(`AGENTIC_BROWSER_SMOKE ${JSON.stringify(result)}`)

    runtime.window.close()
    await phaseZeroProbe?.close()
    phaseZeroProbe = null
    cleanupAutomatedDownloads()
    app.exit(passed ? 0 : 1)
    return
  }

  if (recoverySmokeTest) {
    if (!phaseZeroProbe) {
      throw new Error('Recovery smoke probe server 未启动')
    }
    const result = await runRecoverySmoke(runtime, phaseZeroProbe)
    writeRecoverySmokeResult(result)
    console.log(`AGENTIC_BROWSER_RECOVERY_SMOKE ${JSON.stringify(result)}`)
    runtime.window.close()
    await phaseZeroProbe.close()
    phaseZeroProbe = null
    cleanupAutomatedDownloads()
    app.exit(result.passed === true ? 0 : 1)
    return
  }

  if (watchdogSmokeChild) {
    await runWatchdogSmokeChild(runtime, restoredCheckpoint, watchdogSmokeUrl)
    return
  }

  app.on('activate', () => {
    if (!mainWindow) {
      void createMainWindow()
    }
  })
}).catch((error: unknown) => {
  const result = {
    passed: false,
    error: error instanceof Error ? error.stack ?? error.message : String(error)
  }
  writeSmokeResult(result)
  writeRecoverySmokeResult(result)
  void phaseZeroProbe?.close()
  phaseZeroProbe = null
  cleanupAutomatedDownloads()
  void mainProcessHeartbeat?.stop()
  console.error(error)
  app.exit(1)
})

app.on('before-quit', () => {
  void mainProcessHeartbeat?.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
