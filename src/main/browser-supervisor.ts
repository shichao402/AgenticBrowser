import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  type BaseWindow,
  WebContentsView,
  session,
  type DownloadItem,
  type Event as ElectronEvent,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type OnBeforeRequestListenerDetails,
  type CallbackResponse,
  type Rectangle,
  type RenderProcessGoneDetails,
  type Session,
  type WebFrameMain,
  type WebContents
} from 'electron'

import { STRATEGY_IPC_CHANNELS } from '../shared/contracts'
import type {
  BrowserEvent,
  BrowserEventType,
  BrowserSnapshot,
  CapabilityPolicy,
  CapabilitySettings,
  ContentFilterDefinition,
  DownloadSummary,
  JsonValue,
  PageHealthSnapshot,
  RecoverySnapshot,
  ReloadOptions,
  StrategyDefinition,
  StrategyNetworkRequest,
  StrategyNetworkResponse,
  StrategyRuntimeSnapshot
} from '../shared/contracts'
import {
  type BrowserCheckpoint,
  type BrowserCheckpointStore
} from './checkpoint-store'
import {
  cloneCapabilityPolicy,
  createCapabilityPolicy,
  normalizeCapabilityOrigin,
  resolveCapabilitySettings
} from './capability-store'
import {
  CaptureRingBuffer,
  type CaptureRingSnapshot
} from './capture-ring-buffer'
import { HealthMonitor } from './health-monitor'
import { normalizeNavigationUrl } from './navigation'
import { sanitizeDownloadFileName } from './download-path'
import { ContentFilter } from './content-filter'
import { RecoveryPolicy, type RecoveryAction } from './recovery-policy'
import { urlMatchesStrategyPattern } from './strategy-match'
import {
  isRedirectStatus,
  parseStrategyBootstrapRequest,
  readStrategyResponseBody,
  sanitizeStrategyRequestHeaders,
  selectStrategyResponseHeaders
} from './strategy-network'
import {
  StrategyRuntime,
  type StrategyDomainEvent,
  type StrategyFrameContext
} from './strategy-runtime'

const DEFAULT_URL = 'https://example.com/'
const DEFAULT_PROFILE_ID = 'profile-default'
export const REMOTE_PAGE_SECURITY = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: true,
  backgroundThrottling: false
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
    backgroundThrottling: boolean
  }
  pageWorld: {
    hasNodeProcess: boolean
    hasRequire: boolean
    hasBrowserShellBridge: boolean
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
    strategyMarkerAtInline: string | null
    strategyNodeAtInline: string | null
    strategyPrivateVisibleAtInline: boolean
  } | null
  currentStrategy: {
    startMarker: string | null
    nodeMarker: string | null
    mainWorldMarker: string | null
    privateVisible: boolean
  }
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
  ring: CaptureRingSnapshot
}

export interface InteractionCaptureBenchmark {
  baseline: LatencyStats
  duringCapture: LatencyStats
  p95DeltaMs: number
  captureFps: number
}

export interface MultiViewCaptureBenchmark {
  distinctWebContents: boolean
  capturedPrimaryFrames: number
  auxiliaryResponsive: boolean
  auxiliaryTickAdvanced: boolean
  achievedFps: number
  averageCaptureMs: number
  p95CaptureMs: number
  emptyFrames: number
  encodedBytes: number
  rssDeltaBytes: number
}

export interface LatencyStats {
  sampleCount: number
  averageMs: number
  p95Ms: number
  maximumMs: number
}

export interface HeartbeatStallProbe {
  blockMs: number
  timeoutMs: number
  stallDetected: boolean
  recovered: boolean
  elapsedMs: number
  frozenEvidence: CaptureRingSnapshot
  liveEvidenceBytes: number
  liveEvidenceCaptureMs: number
  liveEvidenceCapturedBeforeRecovery: boolean
}

export interface BrowserSupervisorOptions {
  initialUrl?: string
  strategyPreloadPath?: string
  phaseZeroProbe?: boolean
  profileId?: string
  checkpointStore?: BrowserCheckpointStore
  healthMonitoring?: boolean
  recoveryEnabled?: boolean
  visible?: boolean
  strategyPaused?: boolean
  capabilityPolicy?: CapabilityPolicy
  downloadDirectory?: string
  manageSessionHandlers?: boolean
  strategyDefinitions?: StrategyDefinition[]
  allowedStrategyIds?: ReadonlySet<string>
  quarantinedStrategyIds?: Set<string>
  contentFilter?: ContentFilterDefinition
  onStrategyDomainEvent?: (
    event: StrategyDomainEvent
  ) => JsonValue | void | Promise<JsonValue | void>
  downloadAdapter?: BrowserDownloadAdapter
}

export interface BrowserDownloadRequest {
  sourcePage: string
  sourceUrl: string
  urlChain: string[]
  originalFileName: string
  mime: string | null
  expectedBytes: number | null
}

export type BrowserDownloadReservation =
  | {
      kind: 'reserved'
      downloadId: string
      temporaryPath: string
      displayName: string
    }
  | {
      kind: 'duplicate'
      downloadId: string
      finalPath: string
      displayName: string
    }

export interface BrowserDownloadAdapter {
  reserve(request: BrowserDownloadRequest): Promise<BrowserDownloadReservation>
  markDownloading(downloadId: string): Promise<void>
  complete(downloadId: string): Promise<{ finalPath: string; size: number }>
  fail(
    downloadId: string,
    category: 'network' | 'cancelled' | 'unknown',
    detail: string
  ): Promise<void>
}

export interface NetworkFaultDiagnostics {
  armedAfterBytes: number | null
  offline: boolean
  injectedDrops: number
}

export class BrowserSupervisor {
  private readonly profileSession: Session
  private readonly profileId: string
  private readonly healthMonitor: HealthMonitor
  private readonly recoveryPolicy = new RecoveryPolicy()
  private strategyDefinitions: StrategyDefinition[]
  private allowedStrategyIds: ReadonlySet<string>
  private readonly quarantinedStrategyIds: Set<string>
  private strategyRuntime: StrategyRuntime | null = null
  private capabilityPolicy: CapabilityPolicy
  private readonly contentFilter: ContentFilter
  private downloadAdapter: BrowserDownloadAdapter | undefined
  private insertedFilterCssKey: string | null = null
  private readonly downloads: DownloadSummary = {
    active: 0,
    completed: 0,
    failed: 0,
    receivedBytes: 0
  }
  private downloadSequence = 0
  private networkDropAfterBytes: number | null = null
  private networkOfflineForDiagnostics = false
  private injectedNetworkDrops = 0
  private readonly onWillDownload = (
    _event: ElectronEvent,
    item: DownloadItem,
    webContents: WebContents
  ): void => {
    this.handleDownload(item, webContents)
  }
  private readonly onBeforeRequest = (
    details: OnBeforeRequestListenerDetails,
    callback: (response: CallbackResponse) => void
  ): void => {
    const decision = this.contentFilter.decide(
      details.url,
      details.resourceType
    )
    callback({ cancel: decision.blocked })
  }
  private sessionHandlersEnabled = false
  private pageView: WebContentsView | null = null
  private visible = true
  private strategyPaused = false
  private bounds: Rectangle = { x: 320, y: 72, width: 960, height: 728 }
  private currentUrl: string
  private generation = 0
  private sequence = 0
  private responsive = true
  private lastEvent: BrowserEvent | null = null
  private disposed = false
  private readonly preloadErrors: string[] = []
  private lastPublishedHealthStatus: PageHealthSnapshot['status'] = 'stopped'
  private recoveryEpoch = 0
  private recoveryInFlight: {
    epoch: number
    promise: Promise<void>
  } | null = null
  private recovery: RecoverySnapshot = {
    status: 'idle',
    attemptsInWindow: 0,
    lastAction: null,
    lastReason: null,
    lastRecoveryAt: null
  }

  constructor(
    private readonly window: BaseWindow,
    private readonly publish: (event: BrowserEvent) => void,
    private readonly options: BrowserSupervisorOptions = {}
  ) {
    this.currentUrl = options.initialUrl ?? DEFAULT_URL
    this.strategyDefinitions = [...(options.strategyDefinitions ?? [])]
    this.allowedStrategyIds = new Set(options.allowedStrategyIds ?? [])
    this.quarantinedStrategyIds =
      options.quarantinedStrategyIds ?? new Set<string>()
    this.capabilityPolicy = cloneCapabilityPolicy(
      options.capabilityPolicy ?? createCapabilityPolicy()
    )
    this.contentFilter = new ContentFilter(
      options.contentFilter ?? {
        enabled: false,
        networkRules: [],
        cssRules: []
      },
      (hit) => {
        this.emit(
          'filter-hit',
          `${hit.action}; ${hit.ruleId}; ${hit.resourceType}; ${hit.url}`
        )
      }
    )
    this.downloadAdapter = options.downloadAdapter
    this.visible = options.visible ?? true
    this.strategyPaused = options.strategyPaused ?? false
    this.profileId = options.profileId ?? DEFAULT_PROFILE_ID
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(this.profileId)) {
      throw new Error('Profile ID 格式无效')
    }
    this.profileSession = session.fromPartition(`persist:${this.profileId}`, {
      cache: true
    })
    this.healthMonitor = new HealthMonitor(
      () => this.pingRenderer(400),
      (snapshot) => {
        this.responsive =
          snapshot.status !== 'unresponsive' && snapshot.status !== 'stopped'
        if (snapshot.status !== this.lastPublishedHealthStatus) {
          this.lastPublishedHealthStatus = snapshot.status
          this.emit(
            'health-changed',
            `${snapshot.status}; failures=${snapshot.consecutiveFailures}`
          )
        }
      },
      async () => {
        if (this.options.recoveryEnabled !== false) {
          await this.requestRecovery('heartbeat-timeout')
        }
      }
    )
    this.configureSession()
    this.setSessionHandlerOwnership(options.manageSessionHandlers !== false)
  }

  async start(): Promise<void> {
    await this.createPageView('created')
    if (this.options.healthMonitoring !== false) {
      this.healthMonitor.start()
    }
  }

  setBounds(bounds: Rectangle): void {
    this.bounds = bounds
    this.pageView?.setBounds(bounds)
  }

  getSnapshot(): BrowserSnapshot {
    const contents = this.pageView?.webContents

    return {
      url:
        contents && !contents.isDestroyed()
          ? contents.getURL() || this.currentUrl
          : this.currentUrl,
      title: contents && !contents.isDestroyed() ? contents.getTitle() : '',
      loading:
        contents && !contents.isDestroyed() ? contents.isLoading() : false,
      responsive: this.responsive,
      generation: this.generation,
      lastEvent: this.lastEvent,
      health: this.healthMonitor.getSnapshot(),
      recovery: { ...this.recovery }
    }
  }

  getCapabilityPolicy(): CapabilityPolicy {
    return cloneCapabilityPolicy(this.capabilityPolicy)
  }

  setCapabilityPolicy(policy: CapabilityPolicy): CapabilityPolicy {
    this.capabilityPolicy = cloneCapabilityPolicy(policy)
    return this.getCapabilityPolicy()
  }

  setContentFilter(definition: ContentFilterDefinition): void {
    this.contentFilter.update(definition)
    if (this.sessionHandlersEnabled) {
      this.configureRequestFilter()
    }
    void this.applyContentFilterCss()
  }

  setDownloadAdapter(adapter: BrowserDownloadAdapter | undefined): void {
    this.downloadAdapter = adapter
  }

  armManagedDownloadNetworkDropForDiagnostics(afterBytes = 1): void {
    if (!Number.isSafeInteger(afterBytes) || afterBytes <= 0) {
      throw new Error('下载断网注入阈值必须是正整数')
    }
    this.profileSession.disableNetworkEmulation()
    this.networkOfflineForDiagnostics = false
    this.networkDropAfterBytes = afterBytes
  }

  disableNetworkEmulationForDiagnostics(): void {
    this.profileSession.disableNetworkEmulation()
    this.networkDropAfterBytes = null
    this.networkOfflineForDiagnostics = false
  }

  getNetworkFaultDiagnostics(): NetworkFaultDiagnostics {
    return {
      armedAfterBytes: this.networkDropAfterBytes,
      offline: this.networkOfflineForDiagnostics,
      injectedDrops: this.injectedNetworkDrops
    }
  }

  getEffectiveCapabilities(
    requestingUrlOrOrigin: string = this.currentUrl
  ): CapabilitySettings {
    return resolveCapabilitySettings(
      this.capabilityPolicy,
      requestingUrlOrOrigin
    )
  }

  getDownloadSummary(): DownloadSummary {
    return { ...this.downloads }
  }

  getStrategyRuntimeSnapshot(): StrategyRuntimeSnapshot {
    return (
      this.strategyRuntime?.getSnapshot() ?? {
        activeCount: 0,
        quarantinedStrategyIds: [...this.quarantinedStrategyIds].sort(),
        entries: []
      }
    )
  }

  async setStrategyConfiguration(
    definitions: StrategyDefinition[],
    allowedStrategyIds: ReadonlySet<string>
  ): Promise<void> {
    this.strategyDefinitions = [...definitions]
    this.allowedStrategyIds = new Set(allowedStrategyIds)
    this.quarantinedStrategyIds.clear()
    if (this.pageView && !this.disposed) {
      await this.recreate('strategy-hot-reload')
      this.emit(
        'strategy-reloaded',
        `${definitions.length} definitions; ${allowedStrategyIds.size} allowed`
      )
    }
  }

  async setStrategyPaused(paused: boolean): Promise<void> {
    if (this.strategyPaused === paused) {
      return
    }
    this.strategyPaused = paused
    if (this.pageView && !this.disposed) {
      await this.recreate(
        paused ? 'strategy-manual-takeover' : 'strategy-automation-resumed'
      )
      this.emit(
        'strategy-reloaded',
        paused ? 'manual takeover; 0 allowed' : 'automation resumed'
      )
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.pageView?.setVisible(visible)
  }

  setSessionHandlerOwnership(enabled: boolean): void {
    if (enabled === this.sessionHandlersEnabled) {
      return
    }
    this.sessionHandlersEnabled = enabled
    if (enabled) {
      this.profileSession.on('will-download', this.onWillDownload)
      this.configureRequestFilter()
    } else {
      this.profileSession.removeListener('will-download', this.onWillDownload)
      this.profileSession.webRequest.onBeforeRequest(null)
    }
  }

  takePermissionHandlerOwnership(): void {
    this.configurePermissionHandlers()
  }

  async navigate(input: string): Promise<BrowserSnapshot> {
    const url = normalizeNavigationUrl(input)
    const contents = this.requireContents()
    this.resetRecovery()
    this.pageView?.setVisible(this.visible)
    this.currentUrl = url
    await contents.loadURL(url)
    return this.getSnapshot()
  }

  async reload(options: ReloadOptions): Promise<BrowserSnapshot> {
    const contents = this.requireContents()
    this.resetRecovery()
    this.pageView?.setVisible(this.visible)

    if (options.ignoreCache) {
      contents.reloadIgnoringCache()
    } else {
      contents.reload()
    }

    return this.getSnapshot()
  }

  async collectDiagnostics(
    shellWebContentsId: number
  ): Promise<BrowserDiagnostics> {
    const contents = this.requireContents()
    const pageWorld = (await contents.executeJavaScript(`
      ({
        hasNodeProcess:
          typeof globalThis.process !== 'undefined' &&
          Boolean(globalThis.process?.versions?.node),
        hasRequire: typeof globalThis.require === 'function',
        hasBrowserShellBridge: typeof globalThis.agenticBrowser !== 'undefined'
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
          .some(
            (script) => script.filePath === this.options.strategyPreloadPath
          ),
      preloadErrors: [...this.preloadErrors],
      generation: this.generation
    }
  }

  async collectFrameDiagnostics(): Promise<FrameDiagnostics[]> {
    const contents = this.requireContents()
    const mainFrame = contents.mainFrame

    return Promise.all(
      mainFrame.framesInSubtree.map(async (frame) => {
        const diagnostics = (await frame.executeJavaScript(`({
          observation: globalThis.__phaseZeroInlineObservation ?? null,
          currentStrategy: {
            startMarker:
              document.documentElement.dataset.agenticStrategyStart ?? null,
            nodeMarker:
              document.documentElement.dataset.agenticStrategyNode ?? null,
            mainWorldMarker:
              globalThis.__agenticStrategyMainWorld ?? null,
            privateVisible:
              Boolean(globalThis.__agenticStrategyPrivate)
          }
        })`)) as Pick<FrameDiagnostics, 'observation' | 'currentStrategy'>

        return {
          url: frame.url,
          processId: frame.processId,
          routingId: frame.routingId,
          isMainFrame: frame === mainFrame,
          ...diagnostics
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

  async setProfileCookieForDiagnostics(
    name: string,
    value: string
  ): Promise<void> {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
      throw new Error('Cookie 名称格式无效')
    }
    const url = new URL(this.currentUrl)
    await this.profileSession.cookies.set({
      url: url.origin,
      name,
      value,
      path: '/'
    })
  }

  requestDownload(url: string): void {
    this.requireContents().downloadURL(normalizeNavigationUrl(url))
  }

  async triggerPopup(url: string): Promise<void> {
    const normalized = normalizeNavigationUrl(url)
    await this.requireContents().executeJavaScript(
      `{ window.open(${JSON.stringify(normalized)}, '_blank'); true; }`
    )
  }

  async queryPermissionForDiagnostics(
    permission: 'geolocation' | 'notifications'
  ): Promise<string> {
    return this.requireContents().executeJavaScript(
      `navigator.permissions.query({ name: ${JSON.stringify(
        permission
      )} }).then((status) => status.state)`
    ) as Promise<string>
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

  async benchmarkCapture(
    frameCount = 20,
    intervalMs = 100
  ): Promise<CaptureBenchmark> {
    this.requireContents()
    const durations: number[] = []
    const ring = new CaptureRingBuffer(10, 1024 * 1024)
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
      ring.push(encoded)
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
        durations.reduce((total, duration) => total + duration, 0) /
        durations.length,
      p95CaptureMs: sortedDurations[p95Index] ?? 0,
      encodedBytes,
      emptyFrames,
      rssDeltaBytes: process.memoryUsage().rss - rssBefore,
      ring: ring.getSnapshot()
    }
  }

  async benchmarkInteractionDuringCapture(
    sampleCount = 20
  ): Promise<InteractionCaptureBenchmark> {
    await this.capturePageWithRetry()
    const baseline = await this.sampleRendererLatency(sampleCount, 20)
    const capturePromise = this.benchmarkCapture(20, 100)
    await new Promise((resolve) => setTimeout(resolve, 450))
    const duringCapture = await this.sampleRendererLatency(sampleCount, 75)
    const capture = await capturePromise

    return {
      baseline,
      duringCapture,
      p95DeltaMs: duringCapture.p95Ms - baseline.p95Ms,
      captureFps: capture.achievedFps
    }
  }

  async benchmarkMultiViewCapture(
    frameCount = 20,
    intervalMs = 100
  ): Promise<MultiViewCaptureBenchmark> {
    const primaryView = this.pageView
    if (!primaryView) {
      throw new Error('浏览器页面当前不可用')
    }

    const primaryContents = this.requireContents()
    const auxiliaryView = new WebContentsView({
      webPreferences: {
        ...REMOTE_PAGE_SECURITY,
        session: session.fromPartition(
          `agentic-capture-benchmark-${process.pid}-${Date.now()}`
        )
      }
    })
    const auxiliaryContents = auxiliaryView.webContents
    auxiliaryContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const leftWidth = Math.floor(this.bounds.width / 2)
    const rightWidth = this.bounds.width - leftWidth
    const durations: number[] = []
    const frameStartedAt: number[] = []
    let emptyFrames = 0
    let encodedBytes = 0
    const rssBefore = process.memoryUsage().rss

    this.window.contentView.addChildView(auxiliaryView)
    primaryView.setBounds({
      ...this.bounds,
      width: leftWidth
    })
    auxiliaryView.setBounds({
      x: this.bounds.x + leftWidth,
      y: this.bounds.y,
      width: rightWidth,
      height: this.bounds.height
    })
    primaryView.setVisible(true)
    auxiliaryView.setVisible(true)

    try {
      await auxiliaryContents.loadURL(this.currentUrl)
      primaryContents.invalidate()
      auxiliaryContents.invalidate()
      await new Promise((resolve) => setTimeout(resolve, 750))
      await this.captureContentsWithRetry(primaryContents, 20)
      const auxiliaryTickBefore = Number(
        await auxiliaryContents.executeJavaScript(
          'document.documentElement.dataset.tick ?? "0"'
        )
      )
      const startedAt = performance.now()

      for (let index = 0; index < frameCount; index += 1) {
        const waitMs = startedAt + index * intervalMs - performance.now()
        if (waitMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, waitMs))
        }

        const captureStartedAt = performance.now()
        frameStartedAt.push(captureStartedAt)
        const image = await this.captureContentsWithRetry(primaryContents, 10)
        durations.push(performance.now() - captureStartedAt)

        const encoded = image.toJPEG(70)
        encodedBytes += encoded.byteLength
        if (image.isEmpty() || encoded.byteLength === 0) {
          emptyFrames += 1
        }
      }

      const auxiliaryTickAfter = Number(
        await auxiliaryContents.executeJavaScript(
          'document.documentElement.dataset.tick ?? "0"'
        )
      )
      const stats = summarizeLatencies(durations)
      return {
        distinctWebContents: primaryContents.id !== auxiliaryContents.id,
        capturedPrimaryFrames: frameCount,
        auxiliaryResponsive: !auxiliaryContents.isCrashed(),
        auxiliaryTickAdvanced: auxiliaryTickAfter > auxiliaryTickBefore,
        achievedFps:
          frameStartedAt.length > 1
            ? ((frameStartedAt.length - 1) * 1000) /
              ((frameStartedAt.at(-1) ?? startedAt) - frameStartedAt[0]!)
            : 0,
        averageCaptureMs: stats.averageMs,
        p95CaptureMs: stats.p95Ms,
        emptyFrames,
        encodedBytes,
        rssDeltaBytes: process.memoryUsage().rss - rssBefore
      }
    } finally {
      this.window.contentView.removeChildView(auxiliaryView)
      if (!auxiliaryContents.isDestroyed()) {
        auxiliaryContents.close()
      }
      primaryView.setBounds(this.bounds)
    }
  }

  async probeHeartbeatStall(
    blockMs = 2_000,
    timeoutMs = 250
  ): Promise<HeartbeatStallProbe> {
    const contents = this.requireContents()
    const evidenceRing = new CaptureRingBuffer(3, 1024 * 1024)
    for (let index = 0; index < 3; index += 1) {
      evidenceRing.push((await this.capturePageWithRetry()).toJPEG(70))
    }

    const startedAt = performance.now()
    let rendererExecutionFinished = false
    const execution = contents
      .executeJavaScript(
        `
        {
          const blockedUntil = performance.now() + ${blockMs};
          while (performance.now() < blockedUntil) {
            // Intentional Phase 0 renderer hang.
          }
          true;
        }
      `
      )
      .finally(() => {
        rendererExecutionFinished = true
      })

    await new Promise((resolve) => setTimeout(resolve, 50))
    const stallDetected = !(await this.pingRenderer(timeoutMs))
    const frozenEvidence = evidenceRing.freeze('renderer-heartbeat-stalled')
    const liveEvidenceStartedAt = performance.now()
    let liveEvidenceBytes = 0
    let liveEvidenceCapturedBeforeRecovery = false
    try {
      const liveEvidence = await this.capturePageWithRetry()
      liveEvidenceBytes = liveEvidence.toJPEG(70).byteLength
      liveEvidenceCapturedBeforeRecovery =
        !rendererExecutionFinished &&
        !liveEvidence.isEmpty() &&
        liveEvidenceBytes > 0
    } catch {
      // The frozen pre-failure ring remains available when live capture is impossible.
    }
    const liveEvidenceCaptureMs = performance.now() - liveEvidenceStartedAt
    await execution
    const recovered = await this.pingRenderer(timeoutMs)

    return {
      blockMs,
      timeoutMs,
      stallDetected,
      recovered,
      elapsedMs: performance.now() - startedAt,
      frozenEvidence,
      liveEvidenceBytes,
      liveEvidenceCaptureMs,
      liveEvidenceCapturedBeforeRecovery
    }
  }

  private async capturePageWithRetry() {
    return this.captureContentsWithRetry(this.requireContents())
  }

  private async captureContentsWithRetry(contents: WebContents, attempts = 5) {
    let lastError: unknown

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await contents.capturePage()
      } catch (error) {
        lastError = error
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }

    throw lastError
  }

  private async sampleRendererLatency(
    sampleCount: number,
    intervalMs: number
  ): Promise<LatencyStats> {
    if (!Number.isInteger(sampleCount) || sampleCount <= 0) {
      throw new Error('sampleCount 必须是正整数')
    }

    const contents = this.requireContents()
    const durations: number[] = []
    const startedAt = performance.now()

    for (let index = 0; index < sampleCount; index += 1) {
      const waitMs = startedAt + index * intervalMs - performance.now()
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs))
      }

      const sampleStartedAt = performance.now()
      await contents.executeJavaScript('performance.now()')
      durations.push(performance.now() - sampleStartedAt)
    }

    return summarizeLatencies(durations)
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

    await this.healthMonitor.stopAndWait()
    this.destroyPageView()
    await this.createPageView('recreated', reason)
    if (this.options.healthMonitoring !== false) {
      this.healthMonitor.start()
    }
  }

  async prepareForShutdown(): Promise<void> {
    await this.healthMonitor.stopAndWait()
  }

  dispose(windowClosed = false): void {
    this.disposed = true
    this.healthMonitor.stop()
    if (
      this.networkOfflineForDiagnostics ||
      this.networkDropAfterBytes !== null
    ) {
      this.disableNetworkEmulationForDiagnostics()
    }
    this.setSessionHandlerOwnership(false)
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

    this.configurePermissionHandlers()
  }

  private configureRequestFilter(): void {
    this.profileSession.webRequest.onBeforeRequest(
      {
        urls: ['http://*/*', 'https://*/*']
      },
      this.onBeforeRequest
    )
  }

  private async applyContentFilterCss(): Promise<void> {
    const contents = this.pageView?.webContents
    if (!contents || contents.isDestroyed()) {
      return
    }
    if (this.insertedFilterCssKey) {
      await contents
        .removeInsertedCSS(this.insertedFilterCssKey)
        .catch(() => undefined)
      this.insertedFilterCssKey = null
    }
    const filter = this.contentFilter.cssForUrl(
      contents.getURL() || this.currentUrl
    )
    if (filter.css.length === 0) {
      return
    }
    this.insertedFilterCssKey = await contents.insertCSS(filter.css, {
      cssOrigin: 'user'
    })
    this.emit(
      'filter-css-applied',
      `${filter.ruleIds.join(',')}; ${contents.getURL() || this.currentUrl}`
    )
  }

  private configurePermissionHandlers(): void {
    this.profileSession.setPermissionCheckHandler(
      (contents, permission, requestingOrigin, details) =>
        this.isPermissionAllowed(
          permission,
          details.securityOrigin ??
            requestingOrigin ??
            details.requestingUrl ??
            contents?.getURL()
        )
    )
    this.profileSession.setPermissionRequestHandler(
      (contents, permission, callback, details) => {
        const requestingOrigin =
          ('securityOrigin' in details ? details.securityOrigin : undefined) ??
          details.requestingUrl ??
          contents.getURL()
        const allowed = this.isPermissionAllowed(permission, requestingOrigin)
        callback(allowed)
      }
    )
  }

  private installStrategyRuntime(webContents: WebContents): void {
    const runtime = new StrategyRuntime({
      definitions: this.strategyPaused ? [] : this.strategyDefinitions,
      allowedStrategyIds: this.allowedStrategyIds,
      quarantinedStrategyIds: this.quarantinedStrategyIds,
      onEvent: (event) => {
        if (this.strategyRuntime === runtime && !this.disposed) {
          this.emit(event.type, `${event.strategyId}; ${event.detail}`)
        }
      },
      onDomainEvent: (event) => {
        if (this.strategyRuntime === runtime && !this.disposed) {
          return this.options.onStrategyDomainEvent?.(event)
        }
        return undefined
      },
      onFault: (strategyId, reason) => {
        if (this.strategyRuntime === runtime && !this.disposed) {
          this.handleStrategyFault(strategyId, reason)
        }
      },
      requestNetwork: (definition, request) =>
        this.performStrategyNetworkRequest(definition, request)
    })
    this.strategyRuntime?.dispose()
    this.strategyRuntime = runtime

    webContents.ipc.on(
      STRATEGY_IPC_CHANNELS.bootstrap,
      (event: IpcMainEvent, value: unknown) => {
        if (this.strategyRuntime !== runtime) {
          event.returnValue = { entries: [] }
          return
        }
        const frame = this.parseStrategyFrame(event.senderFrame, value)
        event.returnValue = frame ? runtime.bootstrap(frame) : { entries: [] }
      }
    )
    webContents.ipc.on(
      STRATEGY_IPC_CHANNELS.signal,
      (event: IpcMainEvent, value: unknown) => {
        if (this.strategyRuntime !== runtime) {
          return
        }
        const frame = this.parseStrategyFrame(event.senderFrame)
        if (frame) {
          runtime.signal(frame, value)
        }
      }
    )
    webContents.ipc.handle(
      STRATEGY_IPC_CHANNELS.invoke,
      (event: IpcMainInvokeEvent, value: unknown) => {
        if (this.strategyRuntime !== runtime) {
          throw new Error('Strategy Runtime 已失效')
        }
        const frame = this.parseStrategyFrame(event.senderFrame)
        if (!frame) {
          throw new Error('Strategy frame 已失效')
        }
        return runtime.invoke(frame, value)
      }
    )
    runtime.start()
  }

  private parseStrategyFrame(
    senderFrame: WebFrameMain | null,
    bootstrapValue?: unknown
  ): StrategyFrameContext | null {
    if (!senderFrame || senderFrame.isDestroyed()) {
      return null
    }
    const isMainFrame = senderFrame.parent === null
    let url: string
    try {
      const parsed = new URL(senderFrame.url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null
      }
      url = parsed.toString()
    } catch {
      return null
    }

    if (bootstrapValue !== undefined) {
      const request = parseStrategyBootstrapRequest(bootstrapValue)
      if (!request || request.isMainFrame !== isMainFrame) {
        return null
      }
      try {
        if (new URL(request.href).toString() !== url) {
          return null
        }
      } catch {
        return null
      }
    }

    return {
      frameTreeNodeId: senderFrame.frameTreeNodeId,
      url,
      isMainFrame
    }
  }

  private handleStrategyFault(strategyId: string, reason: string): void {
    if (this.quarantinedStrategyIds.has(strategyId)) {
      return
    }
    this.quarantinedStrategyIds.add(strategyId)
    this.emit('strategy-quarantined', `${strategyId}; ${reason}`)

    const contents = this.pageView?.webContents
    if (contents && !contents.isDestroyed()) {
      contents.forcefullyCrashRenderer()
    }
  }

  private async performStrategyNetworkRequest(
    definition: StrategyDefinition,
    request: StrategyNetworkRequest
  ): Promise<StrategyNetworkResponse> {
    const headers = sanitizeStrategyRequestHeaders(request.headers ?? {})
    const method = request.method ?? 'GET'
    if ((method === 'GET' || method === 'HEAD') && request.body !== undefined) {
      throw new Error(`${method} 请求不能包含 body`)
    }

    let currentUrl = request.url
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      if (
        !definition.manifest.networkMatches.some((pattern) =>
          urlMatchesStrategyPattern(currentUrl, pattern)
        )
      ) {
        throw new Error(`Strategy 重定向未命中网络 allowlist：${currentUrl}`)
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15_000)
      timeout.unref()
      let response: Response
      try {
        response = await this.profileSession.fetch(currentUrl, {
          method,
          headers,
          ...(request.body === undefined ? {} : { body: request.body }),
          credentials: 'include',
          redirect: 'manual',
          signal: controller.signal
        })
      } finally {
        clearTimeout(timeout)
      }

      if (isRedirectStatus(response.status)) {
        const location = response.headers.get('location')
        if (!location) {
          throw new Error('Strategy 网络重定向缺少 Location')
        }
        void response.body?.cancel()
        currentUrl = new URL(location, currentUrl).toString()
        continue
      }

      const declaredLength = Number(response.headers.get('content-length'))
      if (Number.isFinite(declaredLength) && declaredLength > 1024 * 1024) {
        throw new Error('Strategy 网络响应超过 1 MiB')
      }
      const body = await readStrategyResponseBody(response, 1024 * 1024)

      return {
        url: response.url || currentUrl,
        status: response.status,
        headers: selectStrategyResponseHeaders(response.headers),
        body: body.toString('utf8')
      }
    }
    throw new Error('Strategy 网络重定向超过 5 次')
  }

  private async createPageView(
    eventType: Extract<BrowserEventType, 'created' | 'recreated'>,
    detail?: string
  ): Promise<void> {
    const view = new WebContentsView({
      webPreferences: {
        ...REMOTE_PAGE_SECURITY,
        session: this.profileSession,
        additionalArguments: [
          '--agentic-strategy-runtime',
          ...(this.options.phaseZeroProbe ? ['--agentic-phase0-probe'] : [])
        ]
      }
    })

    this.pageView = view
    this.generation += 1
    this.responsive = true
    this.window.contentView.addChildView(view)
    view.setBounds(this.bounds)
    view.setVisible(this.visible)
    this.installStrategyRuntime(view.webContents)
    this.registerPageEvents(view)
    this.emit(eventType, detail)

    await view.webContents.loadURL(this.currentUrl)
  }

  private registerPageEvents(view: WebContentsView): void {
    const { webContents } = view

    webContents.setWindowOpenHandler(({ url }) => {
      const sourceUrl = webContents.getURL() || this.currentUrl
      if (!this.getEffectiveCapabilities(sourceUrl).popups) {
        this.emit('popup-blocked', url)
        return { action: 'deny' }
      }

      try {
        const normalized = normalizeNavigationUrl(url)
        this.emit('popup-routed', normalized)
        setTimeout(() => {
          void this.navigate(normalized).catch((error: unknown) => {
            this.emit(
              'load-failed',
              error instanceof Error ? error.message : String(error)
            )
          })
        }, 0)
      } catch (error) {
        this.emit(
          'popup-blocked',
          error instanceof Error ? error.message : String(error)
        )
      }
      return { action: 'deny' }
    })

    webContents.on('preload-error', (_event, preloadPath, error) => {
      this.preloadErrors.push(`${preloadPath}: ${error.message}`)
    })

    webContents.on(
      'did-start-navigation',
      (_event, url, _isInPlace, isMainFrame) => {
        if (!isMainFrame) {
          return
        }

        this.currentUrl = url
        this.emit('navigation-started')
      }
    )

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

    webContents.on('did-finish-load', () => {
      void this.applyContentFilterCss().catch((error: unknown) => {
        this.emit(
          'filter-css-applied',
          `failed; ${error instanceof Error ? error.message : String(error)}`
        )
      })
    })

    webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) {
          return
        }

        this.currentUrl = validatedUrl || this.currentUrl
        this.emit('load-failed', `${errorCode}: ${errorDescription}`)
        if (this.options.recoveryEnabled !== false) {
          void this.requestRecovery(`load-failed:${errorCode}`)
        }
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

      if (this.options.recoveryEnabled === false) {
        setTimeout(() => {
          void this.recreate(`renderer ${details.reason}`)
        }, 250)
      } else {
        void this.requestRecovery(
          `renderer-gone:${details.reason}`,
          'recreate-view'
        )
      }
    })
  }

  private isPermissionAllowed(
    permission: string,
    requestingUrlOrOrigin: string | undefined
  ): boolean {
    const origin = requestingUrlOrOrigin
      ? normalizeCapabilityOrigin(requestingUrlOrOrigin)
      : null
    if (!origin) {
      return false
    }
    const capabilities = this.getEffectiveCapabilities(origin)
    switch (permission) {
      case 'notifications':
        return capabilities.notifications
      case 'geolocation':
        return capabilities.geolocation
      case 'media':
        return capabilities.media
      case 'clipboard-read':
        return capabilities.clipboardRead
      case 'fullscreen':
        return capabilities.fullscreen
      default:
        return false
    }
  }

  private handleDownload(item: DownloadItem, webContents?: WebContents): void {
    const downloadDirectory = this.options.downloadDirectory
    const sourceUrl = webContents?.getURL() || item.getURL()
    if (
      !this.getEffectiveCapabilities(sourceUrl).downloads ||
      (!downloadDirectory && !this.downloadAdapter)
    ) {
      item.cancel()
      this.downloads.failed += 1
      this.emit('download-blocked', item.getFilename())
      return
    }
    if (this.downloadAdapter) {
      this.handleManagedDownload(item, sourceUrl, this.downloadAdapter)
      return
    }

    mkdirSync(downloadDirectory!, { recursive: true })
    const safeName = sanitizeDownloadFileName(item.getFilename())
    const savePath = join(
      downloadDirectory!,
      `${Date.now()}-${++this.downloadSequence}-${safeName}`
    )
    item.setSavePath(savePath)
    this.downloads.active += 1
    this.emit('download-started', `${safeName} -> ${savePath}`)

    let accountedBytes = 0
    let lastProgressEventAt = 0
    item.on('updated', () => {
      const received = item.getReceivedBytes()
      this.downloads.receivedBytes += Math.max(0, received - accountedBytes)
      accountedBytes = received
      const now = Date.now()
      if (now - lastProgressEventAt >= 1_000) {
        lastProgressEventAt = now
        this.emit(
          'download-progress',
          `${safeName}; ${received}/${item.getTotalBytes()}`
        )
      }
    })

    item.once('done', (_event, state) => {
      const received = item.getReceivedBytes()
      this.downloads.receivedBytes += Math.max(0, received - accountedBytes)
      this.downloads.active = Math.max(0, this.downloads.active - 1)
      if (state === 'completed') {
        this.downloads.completed += 1
        this.emit('download-completed', `${safeName}; ${received} bytes`)
      } else {
        this.downloads.failed += 1
        this.emit('download-failed', `${safeName}; ${state}`)
      }
    })
  }

  private handleManagedDownload(
    item: DownloadItem,
    sourcePage: string,
    adapter: BrowserDownloadAdapter
  ): void {
    item.pause()
    const totalBytes = item.getTotalBytes()
    void adapter
      .reserve({
        sourcePage,
        sourceUrl: item.getURL(),
        urlChain: item.getURLChain(),
        originalFileName: item.getFilename(),
        mime: item.getMimeType() || null,
        expectedBytes: totalBytes >= 0 ? totalBytes : null
      })
      .then(async (reservation) => {
        if (reservation.kind === 'duplicate') {
          item.cancel()
          this.downloads.completed += 1
          this.emit(
            'download-completed',
            `${reservation.displayName}; duplicate -> ${reservation.finalPath}`
          )
          return
        }

        item.setSavePath(reservation.temporaryPath)
        this.downloads.active += 1
        this.emit(
          'download-started',
          `${reservation.displayName} -> ${reservation.temporaryPath}`
        )
        let accountedBytes = 0
        let lastProgressEventAt = 0
        let diagnosticNetworkDropInjected = false
        item.on('updated', () => {
          const received = item.getReceivedBytes()
          this.downloads.receivedBytes += Math.max(0, received - accountedBytes)
          accountedBytes = received
          if (this.injectManagedDownloadNetworkDrop(received)) {
            diagnosticNetworkDropInjected = true
            // Chromium keeps an established transfer alive after session
            // offline; cancel outside the DownloadItem observer callback.
            setImmediate(() => item.cancel())
          }
          const now = Date.now()
          if (now - lastProgressEventAt >= 1_000) {
            lastProgressEventAt = now
            this.emit(
              'download-progress',
              `${reservation.displayName}; ${received}/${item.getTotalBytes()}`
            )
          }
        })
        item.once('done', (_event, state) => {
          const received = item.getReceivedBytes()
          this.downloads.receivedBytes += Math.max(0, received - accountedBytes)
          this.downloads.active = Math.max(0, this.downloads.active - 1)
          if (state === 'completed') {
            void adapter
              .complete(reservation.downloadId)
              .then((result) => {
                this.downloads.completed += 1
                this.emit(
                  'download-completed',
                  `${reservation.displayName}; ${result.size} bytes -> ${result.finalPath}`
                )
              })
              .catch((error: unknown) => {
                this.downloads.failed += 1
                this.emit(
                  'download-failed',
                  `${reservation.displayName}; ${formatError(error)}`
                )
              })
          } else {
            const category = diagnosticNetworkDropInjected
              ? 'network'
              : state === 'cancelled'
                ? 'cancelled'
                : 'network'
            const detail = diagnosticNetworkDropInjected
              ? 'diagnostic-offline'
              : state
            this.downloads.failed += 1
            this.emit(
              'download-failed',
              `${reservation.displayName}; ${detail}`
            )
            void adapter
              .fail(reservation.downloadId, category, detail)
              .catch((error: unknown) => {
                this.emit(
                  'download-failed',
                  `${reservation.displayName}; persist-error=${formatError(error)}`
                )
              })
          }
        })

        await adapter.markDownloading(reservation.downloadId)
        item.resume()
      })
      .catch((error: unknown) => {
        item.cancel()
        this.downloads.failed += 1
        this.emit(
          'download-failed',
          `${item.getFilename()}; ${formatError(error)}`
        )
      })
  }

  private injectManagedDownloadNetworkDrop(receivedBytes: number): boolean {
    const threshold = this.networkDropAfterBytes
    if (
      threshold === null ||
      this.networkOfflineForDiagnostics ||
      receivedBytes < threshold
    ) {
      return false
    }
    this.networkDropAfterBytes = null
    this.networkOfflineForDiagnostics = true
    this.injectedNetworkDrops += 1
    this.profileSession.enableNetworkEmulation({ offline: true })
    return true
  }

  private requestRecovery(
    reason: string,
    minimumAction?: Exclude<RecoveryAction, 'open-circuit'>
  ): Promise<void> {
    if (this.disposed) {
      return Promise.resolve()
    }
    const epoch = this.recoveryEpoch
    if (this.recoveryInFlight?.epoch === epoch) {
      return this.recoveryInFlight.promise
    }

    const recovery = this.runRecovery(reason, minimumAction, epoch).catch(
      (error: unknown) => {
        this.responsive = false
        this.pageView?.setVisible(false)
        this.recovery = {
          ...this.recovery,
          status: 'circuit-open',
          lastReason: error instanceof Error ? error.message : String(error),
          lastRecoveryAt: new Date().toISOString()
        }
        this.emit('circuit-open', this.recovery.lastReason ?? reason)
      }
    )
    this.recoveryInFlight = {
      epoch,
      promise: recovery
    }
    void recovery.finally(() => {
      if (this.recoveryInFlight?.promise === recovery) {
        this.recoveryInFlight = null
      }
    })
    return recovery
  }

  private async runRecovery(
    initialReason: string,
    minimumAction: Exclude<RecoveryAction, 'open-circuit'> | undefined,
    epoch: number
  ): Promise<void> {
    let reason = initialReason

    while (!this.disposed && epoch === this.recoveryEpoch) {
      const decision = this.recoveryPolicy.next(
        reason,
        Date.now(),
        minimumAction
      )
      this.recovery = {
        status:
          decision.action === 'open-circuit' ? 'circuit-open' : 'scheduled',
        attemptsInWindow: this.recoveryPolicy.getAttempts(),
        lastAction: decision.action,
        lastReason: reason,
        lastRecoveryAt: new Date().toISOString()
      }

      if (decision.action === 'open-circuit') {
        this.responsive = false
        this.pageView?.setVisible(false)
        this.emit(
          'circuit-open',
          `${reason}; attempt=${decision.attempt}; budget exhausted`
        )
        return
      }

      this.emit(
        'recovery-scheduled',
        `${decision.action}; attempt=${decision.attempt}; delay=${decision.delayMs}ms`
      )
      await wait(decision.delayMs)
      if (this.disposed || epoch !== this.recoveryEpoch) {
        return
      }

      this.recovery = {
        ...this.recovery,
        status: 'recovering'
      }
      this.emit(
        'recovery-started',
        `${decision.action}; attempt=${decision.attempt}`
      )

      try {
        await this.performRecovery(decision.action)
        this.recovery = {
          ...this.recovery,
          status: 'idle',
          attemptsInWindow: this.recoveryPolicy.getAttempts(),
          lastRecoveryAt: new Date().toISOString()
        }
        this.pageView?.setVisible(this.visible)
        this.emit(
          'recovery-succeeded',
          `${decision.action}; attempt=${decision.attempt}`
        )
        return
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        reason = `${initialReason}; ${decision.action} failed: ${detail}`
      }
    }
  }

  private async performRecovery(
    action: Exclude<RecoveryAction, 'open-circuit'>
  ): Promise<void> {
    if (action === 'recreate-view') {
      await this.recreate(`recovery:${this.recovery.lastReason ?? 'unknown'}`)
      return
    }

    if (action === 'clear-cache-and-reload') {
      await this.profileSession.clearCache()
      await this.reloadAndWait(true)
      return
    }

    await this.reloadAndWait(action === 'reload-ignore-cache')
  }

  private reloadAndWait(
    ignoreCache: boolean,
    timeoutMs = 15_000
  ): Promise<void> {
    const contents = this.requireContents()

    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        contents.removeListener('did-finish-load', onFinished)
        contents.removeListener('did-fail-load', onFailed)
        contents.removeListener('render-process-gone', onRendererGone)
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }
      const onFinished = (): void => finish()
      const onFailed = (
        _event: ElectronEvent,
        errorCode: number,
        errorDescription: string,
        _validatedUrl: string,
        isMainFrame: boolean
      ): void => {
        if (isMainFrame && errorCode !== -3) {
          finish(new Error(`${errorCode}: ${errorDescription}`))
        }
      }
      const onRendererGone = (
        _event: ElectronEvent,
        details: RenderProcessGoneDetails
      ): void => {
        finish(new Error(`renderer ${details.reason}`))
      }
      const timer = setTimeout(() => {
        finish(new Error(`等待 reload 完成超过 ${timeoutMs} ms`))
      }, timeoutMs)
      timer.unref()

      contents.once('did-finish-load', onFinished)
      contents.on('did-fail-load', onFailed)
      contents.once('render-process-gone', onRendererGone)

      if (ignoreCache) {
        contents.reloadIgnoringCache()
      } else {
        contents.reload()
      }
    })
  }

  private resetRecovery(): void {
    this.recoveryEpoch += 1
    this.recoveryPolicy.reset()
    this.recovery = {
      ...this.recovery,
      status: 'idle',
      attemptsInWindow: 0
    }
  }

  private destroyPageView(removeFromWindow = true): void {
    const view = this.pageView
    this.pageView = null
    this.insertedFilterCssKey = null
    this.strategyRuntime?.dispose()
    this.strategyRuntime = null

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

function summarizeLatencies(durations: number[]): LatencyStats {
  if (durations.length === 0) {
    return {
      sampleCount: 0,
      averageMs: 0,
      p95Ms: 0,
      maximumMs: 0
    }
  }

  const sorted = [...durations].sort((left, right) => left - right)
  const p95Index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * 0.95) - 1
  )

  return {
    sampleCount: durations.length,
    averageMs:
      durations.reduce((total, duration) => total + duration, 0) /
      durations.length,
    p95Ms: sorted[p95Index] ?? 0,
    maximumMs: sorted.at(-1) ?? 0
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
