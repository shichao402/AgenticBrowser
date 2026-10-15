import {
  BaseWindow,
  WebContentsView,
  session,
  type Rectangle,
  type Session
} from 'electron'

import type {
  BrowserEvent,
  BrowserEventType,
  BrowserSnapshot,
  ReloadOptions
} from '../shared/contracts'
import {
  type BrowserCheckpoint,
  type BrowserCheckpointStore
} from './checkpoint-store'
import { normalizeNavigationUrl } from './navigation'

const DEFAULT_URL = 'https://example.com/'
const DEFAULT_PROFILE_ID = 'profile-default'
export const REMOTE_PAGE_SECURITY = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: true
} as const

export interface BrowserDiagnostics {
  shellWebContentsId: number
  pageWebContentsId: number
  distinctWebContents: boolean
  preferences: {
    sandbox: boolean
    contextIsolation: boolean
    nodeIntegration: boolean
    nodeIntegrationInSubFrames: boolean
  }
  pageWorld: {
    hasNodeProcess: boolean
    hasRequire: boolean
  }
  strategyPreloadRegistered: boolean
  preloadErrors: string[]
  generation: number
}

export interface FrameDiagnostics {
  url: string
  processId: number
  routingId: number
  isMainFrame: boolean
  observation: {
    label: string
    probeVisibleAtInline: boolean
    preloadReadyState: string | null
    inlineReadyState: string
    inlineAt: number
  } | null
}

export interface CaptureBenchmark {
  frameCount: number
  elapsedMs: number
  achievedFps: number
  averageCaptureMs: number
  p95CaptureMs: number
  encodedBytes: number
  emptyFrames: number
  rssDeltaBytes: number
}

export interface HeartbeatStallProbe {
  blockMs: number
  timeoutMs: number
  stallDetected: boolean
  recovered: boolean
  elapsedMs: number
}

export interface BrowserSupervisorOptions {
  initialUrl?: string
  strategyPreloadPath?: string
  phaseZeroProbe?: boolean
  profileId?: string
  checkpointStore?: BrowserCheckpointStore
}

export class BrowserSupervisor {
  private readonly profileSession: Session
  private readonly profileId: string
  private pageView: WebContentsView | null = null
  private bounds: Rectangle = { x: 320, y: 72, width: 960, height: 728 }
  private currentUrl: string
  private generation = 0
  private sequence = 0
  private responsive = true
  private lastEvent: BrowserEvent | null = null
  private disposed = false
  private readonly preloadErrors: string[] = []

  constructor(
    private readonly window: BaseWindow,
    private readonly publish: (event: BrowserEvent) => void,
    private readonly options: BrowserSupervisorOptions = {}
  ) {
    this.currentUrl = options.initialUrl ?? DEFAULT_URL
    this.profileId = options.profileId ?? DEFAULT_PROFILE_ID
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(this.profileId)) {
      throw new Error('Profile ID 格式无效')
    }
    this.profileSession = session.fromPartition(`persist:${this.profileId}`, {
      cache: true
    })
    this.configureSession()
  }

  async start(): Promise<void> {
    await this.createPageView('created')
  }

  setBounds(bounds: Rectangle): void {
    this.bounds = bounds
    this.pageView?.setBounds(bounds)
  }

  getSnapshot(): BrowserSnapshot {
    const contents = this.pageView?.webContents

    return {
      url: contents && !contents.isDestroyed() ? contents.getURL() || this.currentUrl : this.currentUrl,
      title: contents && !contents.isDestroyed() ? contents.getTitle() : '',
      loading: contents && !contents.isDestroyed() ? contents.isLoading() : false,
      responsive: this.responsive,
      generation: this.generation,
      lastEvent: this.lastEvent
    }
  }

  async navigate(input: string): Promise<BrowserSnapshot> {
    const url = normalizeNavigationUrl(input)
    const contents = this.requireContents()
    this.currentUrl = url
    await contents.loadURL(url)
    return this.getSnapshot()
  }

  async reload(options: ReloadOptions): Promise<BrowserSnapshot> {
    const contents = this.requireContents()

    if (options.ignoreCache) {
      contents.reloadIgnoringCache()
    } else {
      contents.reload()
    }

    return this.getSnapshot()
  }

  async collectDiagnostics(shellWebContentsId: number): Promise<BrowserDiagnostics> {
    const contents = this.requireContents()
    const pageWorld = (await contents.executeJavaScript(`
      ({
        hasNodeProcess:
          typeof globalThis.process !== 'undefined' &&
          Boolean(globalThis.process?.versions?.node),
        hasRequire: typeof globalThis.require === 'function'
      })
    `)) as BrowserDiagnostics['pageWorld']

    return {
      shellWebContentsId,
      pageWebContentsId: contents.id,
      distinctWebContents: shellWebContentsId !== contents.id,
      preferences: {
        ...REMOTE_PAGE_SECURITY
      },
      pageWorld,
      strategyPreloadRegistered:
        this.options.strategyPreloadPath !== undefined &&
        this.profileSession
          .getPreloadScripts()
          .some((script) => script.filePath === this.options.strategyPreloadPath),
      preloadErrors: [...this.preloadErrors],
      generation: this.generation
    }
  }

  async collectFrameDiagnostics(): Promise<FrameDiagnostics[]> {
    const contents = this.requireContents()
    const mainFrame = contents.mainFrame

    return Promise.all(
      mainFrame.framesInSubtree.map(async (frame) => {
        const observation = (await frame.executeJavaScript(
          'globalThis.__phaseZeroInlineObservation ?? null'
        )) as FrameDiagnostics['observation']

        return {
          url: frame.url,
          processId: frame.processId,
          routingId: frame.routingId,
          isMainFrame: frame === mainFrame,
          observation
        }
      })
    )
  }

  async hasProfileCookie(name: string): Promise<boolean> {
    const url = new URL(this.currentUrl)
    const cookies = await this.profileSession.cookies.get({
      url: url.origin,
      name
    })
    return cookies.length > 0
  }

  async flushCheckpoint(reason: string): Promise<BrowserCheckpoint | null> {
    if (!this.options.checkpointStore) {
      return null
    }

    try {
      const checkpoint = await this.options.checkpointStore.write({
        profileId: this.profileId,
        url: this.currentUrl,
        reason
      })
      this.emit('checkpoint-saved', reason)
      return checkpoint
    } catch (error) {
      this.emit(
        'checkpoint-failed',
        error instanceof Error ? error.message : String(error)
      )
      throw error
    }
  }

  async benchmarkCapture(frameCount = 20, intervalMs = 100): Promise<CaptureBenchmark> {
    const contents = this.requireContents()
    const durations: number[] = []
    await new Promise((resolve) => setTimeout(resolve, 500))
    await this.capturePageWithRetry()
    const startedAt = performance.now()
    const rssBefore = process.memoryUsage().rss
    const frameStartedAt: number[] = []
    let encodedBytes = 0
    let emptyFrames = 0

    for (let index = 0; index < frameCount; index += 1) {
      const scheduledAt = startedAt + index * intervalMs
      const waitMs = scheduledAt - performance.now()
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs))
      }

      const captureStartedAt = performance.now()
      frameStartedAt.push(captureStartedAt)
      const image = await this.capturePageWithRetry()
      const encoded = image.toJPEG(70)
      const captureDuration = performance.now() - captureStartedAt
      durations.push(captureDuration)
      encodedBytes += encoded.byteLength
      if (image.isEmpty() || encoded.byteLength === 0) {
        emptyFrames += 1
      }
    }

    const elapsedMs = performance.now() - startedAt
    const sortedDurations = [...durations].sort((left, right) => left - right)
    const p95Index = Math.min(
      sortedDurations.length - 1,
      Math.ceil(sortedDurations.length * 0.95) - 1
    )

    return {
      frameCount,
      elapsedMs,
      achievedFps:
        frameStartedAt.length > 1
          ? ((frameStartedAt.length - 1) * 1000) /
            ((frameStartedAt.at(-1) ?? startedAt) - frameStartedAt[0]!)
          : 0,
      averageCaptureMs:
        durations.reduce((total, duration) => total + duration, 0) / durations.length,
      p95CaptureMs: sortedDurations[p95Index] ?? 0,
      encodedBytes,
      emptyFrames,
      rssDeltaBytes: process.memoryUsage().rss - rssBefore
    }
  }

  async probeHeartbeatStall(
    blockMs = 2_000,
    timeoutMs = 250
  ): Promise<HeartbeatStallProbe> {
    const contents = this.requireContents()
    const startedAt = performance.now()
    const execution = contents.executeJavaScript(`
      {
        const blockedUntil = performance.now() + ${blockMs};
        while (performance.now() < blockedUntil) {
          // Intentional Phase 0 renderer hang.
        }
        true;
      }
    `)

    await new Promise((resolve) => setTimeout(resolve, 50))
    const stallDetected = !(await this.pingRenderer(timeoutMs))
    await execution
    const recovered = await this.pingRenderer(timeoutMs)

    return {
      blockMs,
      timeoutMs,
      stallDetected,
      recovered,
      elapsedMs: performance.now() - startedAt
    }
  }

  private async capturePageWithRetry() {
    const contents = this.requireContents()
    let lastError: unknown

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await contents.capturePage()
      } catch (error) {
        lastError = error
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }

    throw lastError
  }

  private async pingRenderer(timeoutMs: number): Promise<boolean> {
    const contents = this.requireContents()

    return Promise.race([
      contents
        .executeJavaScript('true')
        .then(() => true)
        .catch(() => false),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), timeoutMs)
      })
    ])
  }

  async forceCrashAndWait(timeoutMs = 10_000): Promise<void> {
    const previousGeneration = this.generation
    this.requireContents().forcefullyCrashRenderer()

    await new Promise<void>((resolve, reject) => {
      const startedAt = Date.now()
      const timer = setInterval(() => {
        const contents = this.pageView?.webContents
        if (
          this.generation > previousGeneration &&
          contents &&
          !contents.isDestroyed() &&
          !contents.isLoading()
        ) {
          clearInterval(timer)
          resolve()
          return
        }

        if (Date.now() - startedAt >= timeoutMs) {
          clearInterval(timer)
          reject(new Error('等待 renderer 重建超时'))
        }
      }, 50)
    })
  }

  async recreate(reason: string): Promise<void> {
    if (this.disposed) {
      return
    }

    this.destroyPageView()
    await this.createPageView('recreated', reason)
  }

  dispose(windowClosed = false): void {
    this.disposed = true
    this.destroyPageView(!windowClosed)
  }

  private configureSession(): void {
    if (
      this.options.strategyPreloadPath &&
      !this.profileSession
        .getPreloadScripts()
        .some((script) => script.filePath === this.options.strategyPreloadPath)
    ) {
      this.profileSession.registerPreloadScript({
        type: 'frame',
        filePath: this.options.strategyPreloadPath
      })
    }

    this.profileSession.setPermissionCheckHandler(() => false)
    this.profileSession.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false)
    })
  }

  private async createPageView(
    eventType: Extract<BrowserEventType, 'created' | 'recreated'>,
    detail?: string
  ): Promise<void> {
    const view = new WebContentsView({
      webPreferences: {
        ...REMOTE_PAGE_SECURITY,
        session: this.profileSession,
        ...(this.options.phaseZeroProbe
          ? { additionalArguments: ['--agentic-phase0-probe'] }
          : {})
      }
    })

    this.pageView = view
    this.generation += 1
    this.responsive = true
    this.window.contentView.addChildView(view)
    view.setBounds(this.bounds)
    this.registerPageEvents(view)
    this.emit(eventType, detail)

    await view.webContents.loadURL(this.currentUrl)
  }

  private registerPageEvents(view: WebContentsView): void {
    const { webContents } = view

    webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    webContents.on('preload-error', (_event, preloadPath, error) => {
      this.preloadErrors.push(`${preloadPath}: ${error.message}`)
    })

    webContents.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
      if (!isMainFrame) {
        return
      }

      this.currentUrl = url
      this.emit('navigation-started')
    })

    webContents.on('did-navigate', (_event, url) => {
      this.currentUrl = url
      this.emit('navigation-finished')
      void this.flushCheckpoint('navigation-finished').catch(() => undefined)
    })

    webContents.on('did-start-loading', () => {
      this.emit('load-started')
    })

    webContents.on('did-stop-loading', () => {
      this.emit('load-finished')
    })

    webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) {
          return
        }

        this.currentUrl = validatedUrl || this.currentUrl
        this.emit('load-failed', `${errorCode}: ${errorDescription}`)
      }
    )

    webContents.on('unresponsive', () => {
      this.responsive = false
      this.emit('unresponsive')
    })

    webContents.on('responsive', () => {
      this.responsive = true
      this.emit('responsive')
    })

    webContents.on('render-process-gone', (_event, details) => {
      this.responsive = false
      this.emit('renderer-gone', `${details.reason} (${details.exitCode})`)

      setTimeout(() => {
        void this.recreate(`renderer ${details.reason}`)
      }, 250)
    })
  }

  private destroyPageView(removeFromWindow = true): void {
    const view = this.pageView
    this.pageView = null

    if (!view) {
      return
    }

    if (removeFromWindow) {
      this.window.contentView.removeChildView(view)
    }
    if (!view.webContents.isDestroyed()) {
      view.webContents.close()
    }
  }

  private requireContents() {
    const contents = this.pageView?.webContents
    if (!contents || contents.isDestroyed()) {
      throw new Error('浏览器页面当前不可用')
    }

    return contents
  }

  private emit(type: BrowserEventType, detail?: string): void {
    const event: BrowserEvent = {
      sequence: ++this.sequence,
      type,
      timestamp: new Date().toISOString(),
      url: this.currentUrl,
      ...(detail ? { detail } : {})
    }

    this.lastEvent = event
    this.publish(event)
  }
}
