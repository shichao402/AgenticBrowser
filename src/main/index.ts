import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BaseWindow, ipcMain, WebContentsView } from 'electron'

import { IPC_CHANNELS, type BrowserEvent, type ReloadOptions } from '../shared/contracts'
import { BrowserSupervisor } from './browser-supervisor'
import {
  startPhaseZeroProbeServer,
  type PhaseZeroProbeServer
} from './phase0-probe-server'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const SIDEBAR_WIDTH = 320
const TOOLBAR_HEIGHT = 72
const MIN_PAGE_SIZE = 240

let mainWindow: BaseWindow | null = null
const smokeTest = process.argv.includes('--smoke-test')
const smokeResultPath = join(process.cwd(), 'phase0-smoke-result.json')
let phaseZeroProbe: PhaseZeroProbeServer | null = null

function writeSmokeResult(result: unknown): void {
  if (smokeTest) {
    writeFileSync(smokeResultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  }
}

interface MainWindowRuntime {
  window: BaseWindow
  shellView: WebContentsView
  supervisor: BrowserSupervisor
  events: BrowserEvent[]
}

interface CreateMainWindowOptions {
  show?: boolean
  initialUrl?: string
  phaseZeroProbe?: boolean
}

async function createMainWindow(options: CreateMainWindowOptions = {}): Promise<MainWindowRuntime> {
  const { show = true, initialUrl, phaseZeroProbe = false } = options
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

  const publish = (event: BrowserEvent): void => {
    events.push(event)
    if (!shellView.webContents.isDestroyed()) {
      shellView.webContents.send(IPC_CHANNELS.browserEvent, event)
    }
  }

  const supervisor = new BrowserSupervisor(window, publish, {
    ...(initialUrl ? { initialUrl } : {}),
    strategyPreloadPath: join(currentDirectory, '../preload/strategy-bootstrap.cjs'),
    phaseZeroProbe
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
    ipcMain.removeHandler(IPC_CHANNELS.getSnapshot)
    ipcMain.removeHandler(IPC_CHANNELS.navigate)
    ipcMain.removeHandler(IPC_CHANNELS.reload)

    if (!shellView.webContents.isDestroyed()) {
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
    events
  }
}

app.whenReady().then(async () => {
  app.setAppUserModelId('com.firoyang.agenticbrowser')
  phaseZeroProbe = smokeTest ? await startPhaseZeroProbeServer() : null
  const runtime = await createMainWindow({
    show: true,
    phaseZeroProbe: smokeTest,
    ...(phaseZeroProbe ? { initialUrl: phaseZeroProbe.topUrl } : {})
  })

  if (smokeTest) {
    if (!phaseZeroProbe) {
      throw new Error('Phase 0 probe server 未启动')
    }

    const beforeCrash = await runtime.supervisor.collectDiagnostics(runtime.shellView.webContents.id)
    const framesBeforeCrash = await runtime.supervisor.collectFrameDiagnostics()
    const profileCookieBeforeCrash =
      await runtime.supervisor.hasProfileCookie('agentic_phase0_session')
    const capture = await runtime.supervisor.benchmarkCapture()
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
      beforeCrash.strategyPreloadRegistered &&
      injectedBeforeCrash.length === expectedLabels.size &&
      injectedAfterCrash.length === expectedLabels.size &&
      oopifObserved &&
      profileCookieBeforeCrash &&
      profileCookieAfterCrash &&
      capture.emptyFrames === 0 &&
      capture.achievedFps >= 9.5 &&
      heartbeatStall.stallDetected &&
      heartbeatStall.recovered &&
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
      capture
    }
    writeSmokeResult(result)
    console.log(`AGENTIC_BROWSER_SMOKE ${JSON.stringify(result)}`)

    runtime.window.close()
    await phaseZeroProbe?.close()
    phaseZeroProbe = null
    app.exit(passed ? 0 : 1)
    return
  }

  app.on('activate', () => {
    if (!mainWindow) {
      void createMainWindow()
    }
  })
}).catch((error: unknown) => {
  writeSmokeResult({
    passed: false,
    error: error instanceof Error ? error.stack ?? error.message : String(error)
  })
  void phaseZeroProbe?.close()
  phaseZeroProbe = null
  console.error(error)
  app.exit(1)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
