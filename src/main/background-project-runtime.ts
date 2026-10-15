import { join } from 'node:path'

import type { BaseWindow, Rectangle } from 'electron'

import type {
  BrowserEvent,
  JsonValue,
  ProjectRuntimeRecord,
  StrategyDefinition,
  WorkflowFailureCategory
} from '../shared/contracts'
import { BrowserTabManager } from './browser-tab-manager'
import type {
  BrowserDownloadAdapter,
  BrowserDownloadRequest
} from './browser-supervisor'
import {
  ProjectDownloadManager,
  type ProjectDownloadReservation
} from './project-download-manager'
import type {
  ProjectRuntimeEnvelope,
  ProjectRuntimeStore
} from './project-runtime-store'
import {
  requireRunnableProjectStrategies,
  resolveProjectStrategies
} from './project-strategy-resolver'
import {
  ProjectWorkflowEngine,
  type ProjectWorkflowEvent
} from './project-workflow-engine'
import type { StrategyDomainEvent } from './strategy-runtime'

type ReservedDownload = Extract<
  ProjectDownloadReservation,
  { kind: 'reserved' }
>

export interface BackgroundProjectRuntimeOptions {
  window: BaseWindow
  envelope: ProjectRuntimeEnvelope
  runtimeStore: ProjectRuntimeStore
  strategyDefinitions: StrategyDefinition[]
  strategyPreloadPath: string
  publish(event: BrowserEvent): void
  bounds: Rectangle
  visible?: boolean
  onRuntimeChanged?(runtime: ProjectRuntimeRecord): void
  onTerminal?(runtime: ProjectRuntimeRecord): void | Promise<void>
}

export class BackgroundProjectRuntime {
  readonly supervisor: BrowserTabManager
  private readonly downloadManager: ProjectDownloadManager
  private readonly pendingDownloads: ReservedDownload[] = []
  private readonly queuedEvents: ProjectWorkflowEvent[] = []
  private readonly engine: ProjectWorkflowEngine
  private runtime: ProjectRuntimeRecord
  private ticker: NodeJS.Timeout | null = null
  private terminalTimer: NodeJS.Timeout | null = null
  private tickInFlight = false
  private started = false
  private starting = false
  private lifecycleTransition = false
  private disposed = false
  private terminalNotified = false

  constructor(private readonly options: BackgroundProjectRuntimeOptions) {
    const { envelope } = options
    const startupUrl = envelope.projectSnapshot.startupPages[0]
    if (!startupUrl) {
      throw new Error('Project 至少需要一个初始化页面')
    }
    const resolved = resolveProjectStrategies(
      envelope.projectSnapshot,
      options.strategyDefinitions
    )
    requireRunnableProjectStrategies(resolved)
    this.runtime = structuredClone(envelope.runtime)
    this.downloadManager = new ProjectDownloadManager(
      join(
        envelope.projectSnapshot.output.root,
        'records',
        'downloads.json'
      ),
      { runtimeStore: options.runtimeStore }
    )
    this.engine = new ProjectWorkflowEngine(
      envelope.runtime.runtimeId,
      options.runtimeStore,
      {
        navigate: async (url, signal) => {
          if (signal.aborted) {
            throw new Error('Workflow 导航已取消')
          }
          await this.supervisor.navigate(url)
        },
        onRuntimeChanged: (runtime) => {
          this.setRuntime(runtime)
        }
      }
    )
    this.supervisor = new BrowserTabManager(
      options.window,
      (event) => {
        const tagged: BrowserEvent = {
          ...event,
          projectId: envelope.runtime.projectId,
          runtimeId: envelope.runtime.runtimeId
        }
        options.publish(tagged)
        if (event.type === 'circuit-open') {
          void this.fail(
            'renderer',
            event.detail ?? '浏览器恢复预算已耗尽'
          ).catch(() => undefined)
        }
      },
      {
        initialUrl: startupUrl,
        profileId: envelope.projectSnapshot.profileId,
        strategyPreloadPath: options.strategyPreloadPath,
        healthMonitoring: true,
        recoveryEnabled: true,
        visible: options.visible ?? false,
        capabilityPolicy: envelope.projectSnapshot.capabilities,
        contentFilter: envelope.projectSnapshot.filter,
        downloadAdapter: this.createDownloadAdapter(),
        strategyDefinitions: resolved.definitions,
        allowedStrategyIds: resolved.allowedStrategyIds,
        quarantinedStrategyIds: new Set<string>(),
        onStrategyDomainEvent: (event) =>
          this.handleStrategyDomainEvent(event)
      }
    )
    this.supervisor.setBounds(options.bounds)
  }

  async start(): Promise<ProjectRuntimeRecord> {
    if (this.started) {
      return this.getRuntime()
    }
    this.assertAvailable()
    await this.downloadManager.recoverInterrupted()
    await this.supervisor.start()
    this.started = true
    this.starting = true
    try {
      const runtime = await this.engine.start()
      this.setRuntime(runtime)
      await this.drainQueuedEvents()
      this.starting = false
      this.notifyTerminalIfNeeded(true)
      if (!isTerminalRuntime(this.runtime)) {
        this.startTicker()
      }
      return this.getRuntime()
    } catch (error) {
      this.starting = false
      if (
        this.runtime.status !== 'queued' &&
        !isTerminalRuntime(this.runtime)
      ) {
        const failed = await this.engine
          .fail('unknown', formatError(error))
          .catch(() => null)
        if (failed) {
          this.setRuntime(failed)
        }
      }
      this.supervisor.dispose()
      throw error
    }
  }

  getRuntime(): ProjectRuntimeRecord {
    return structuredClone(this.runtime)
  }

  setBounds(bounds: Rectangle): void {
    this.supervisor.setBounds(bounds)
  }

  setVisible(visible: boolean): void {
    this.supervisor.setVisible(visible)
  }

  async cancel(
    reason = '用户停止 Project Runtime'
  ): Promise<ProjectRuntimeRecord> {
    const runtime = await this.engine.cancel(reason)
    this.setRuntime(runtime)
    return this.getRuntime()
  }

  async pause(): Promise<ProjectRuntimeRecord> {
    this.assertAvailable()
    this.lifecycleTransition = true
    try {
      const runtime = await this.engine.pause()
      this.setRuntime(runtime)
      if (runtime.status !== 'paused') {
        return this.getRuntime()
      }
      this.stopTicker()
      await this.supervisor.setStrategyPaused(true)
      return this.getRuntime()
    } finally {
      this.lifecycleTransition = false
      this.notifyTerminalIfNeeded(true)
    }
  }

  async resume(): Promise<ProjectRuntimeRecord> {
    this.assertAvailable()
    this.lifecycleTransition = true
    try {
      const runtime = await this.engine.resume()
      this.setRuntime(runtime)
      await this.supervisor.setStrategyPaused(false)
      if (!isTerminalRuntime(this.runtime)) {
        this.startTicker()
      }
      return this.getRuntime()
    } catch (error) {
      await this.engine.pause().catch(() => undefined)
      await this.supervisor.setStrategyPaused(true).catch(() => undefined)
      throw error
    } finally {
      this.lifecycleTransition = false
      this.notifyTerminalIfNeeded(true)
    }
  }

  async fail(
    category: WorkflowFailureCategory,
    reason: string
  ): Promise<ProjectRuntimeRecord> {
    if (isTerminalRuntime(this.runtime)) {
      return this.getRuntime()
    }
    const runtime = await this.engine.fail(category, reason)
    this.setRuntime(runtime)
    return this.getRuntime()
  }

  async prepareForShutdown(): Promise<void> {
    await this.supervisor.prepareForShutdown()
  }

  dispose(windowClosed = false): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.stopTicker()
    if (this.terminalTimer) {
      clearTimeout(this.terminalTimer)
      this.terminalTimer = null
    }
    this.supervisor.dispose(windowClosed)
  }

  private createDownloadAdapter(): BrowserDownloadAdapter {
    return {
      reserve: async (request) => this.consumeDownloadIntent(request),
      markDownloading: async (downloadId) => {
        await this.downloadManager.markDownloading(downloadId)
      },
      complete: async (downloadId) => {
        const record = await this.downloadManager.complete(downloadId)
        await this.handleStrategyDomainEvent({
          strategyId: 'host-download-manager',
          name: 'download.completed',
          payload: {
            downloadId: record.downloadId,
            businessItemId: record.businessItemId,
            attachmentId: record.attachmentId,
            finalPath: record.finalPath,
            sha256: record.sha256,
            size: record.size
          },
          url: record.sourcePage
        })
        return { finalPath: record.finalPath, size: record.size }
      },
      fail: async (downloadId, category, detail) => {
        const record = await this.downloadManager.fail(
          downloadId,
          category,
          detail
        )
        await this.handleStrategyDomainEvent({
          strategyId: 'host-download-manager',
          name: 'download.failed',
          payload: {
            downloadId: record.downloadId,
            businessItemId: record.businessItemId,
            attachmentId: record.attachmentId,
            category,
            detail
          },
          url: record.sourcePage
        })
      }
    }
  }

  private async consumeDownloadIntent(request: BrowserDownloadRequest) {
    const requestUrls = new Set(
      [request.sourceUrl, ...request.urlChain].map(
        normalizeComparableUrl
      )
    )
    const index = this.pendingDownloads.findIndex(({ record }) => {
      return (
        requestUrls.has(normalizeComparableUrl(record.sourceUrl)) ||
        (record.originalFileName === request.originalFileName &&
          normalizeComparableUrl(record.sourcePage) ===
            normalizeComparableUrl(request.sourcePage))
      )
    })
    if (index < 0) {
      throw new Error(
        `下载没有已授权的 Strategy 意图：${request.sourceUrl}`
      )
    }
    const [reservation] = this.pendingDownloads.splice(index, 1)
    if (!reservation) {
      throw new Error('下载意图队列状态无效')
    }
    return {
      kind: 'reserved' as const,
      downloadId: reservation.record.downloadId,
      temporaryPath: reservation.record.temporaryPath,
      displayName: reservation.record.safeFileName
    }
  }

  private async handleStrategyDomainEvent(
    event: StrategyDomainEvent
  ): Promise<JsonValue | void> {
    if (event.name === 'download.intent') {
      return this.handleDownloadIntent(event)
    }
    const workflowEvent: ProjectWorkflowEvent = {
      name: event.name,
      ...(event.payload === undefined
        ? {}
        : { payload: structuredClone(event.payload) })
    }
    if (!this.started) {
      if (this.queuedEvents.length >= 100) {
        throw new Error('Project 启动期间领域事件队列已满')
      }
      this.queuedEvents.push(workflowEvent)
      return null
    }
    const runtime = await this.engine.handleEvent(workflowEvent)
    this.setRuntime(runtime)
    return null
  }

  private async handleDownloadIntent(
    event: StrategyDomainEvent
  ): Promise<JsonValue> {
    const intent = parseDownloadIntentPayload(event.payload)
    if (!intent) {
      throw new Error('download.intent payload 格式无效')
    }
    const state = await this.options.runtimeStore.read()
    const envelope = state.runtimes.find(
      ({ runtime }) => runtime.runtimeId === this.runtime.runtimeId
    )
    if (!envelope || isTerminalRuntime(envelope.runtime)) {
      throw new Error('下载意图对应的 Project Runtime 不可用')
    }
    const reservation = await this.downloadManager.reserve(
      envelope.projectSnapshot,
      {
        runtimeId: envelope.runtime.runtimeId,
        workflowNodeId: envelope.runtime.currentNodeId,
        sourcePage: event.url,
        sourceUrl: intent.sourceUrl,
        businessItemId: intent.businessItemId,
        attachmentId: intent.attachmentId,
        originalFileName: intent.originalFileName,
        ...(intent.mime ? { mime: intent.mime } : {}),
        ...(intent.expectedBytes === null
          ? {}
          : { expectedBytes: intent.expectedBytes })
      }
    )
    if (reservation.kind === 'reserved') {
      if (this.pendingDownloads.length >= 100) {
        await this.downloadManager.fail(
          reservation.record.downloadId,
          'unknown',
          '待下载意图队列超过 100'
        )
        throw new Error('待下载意图队列已满')
      }
      this.pendingDownloads.push(reservation)
      return {
        kind: 'reserved',
        downloadId: reservation.record.downloadId,
        safeFileName: reservation.record.safeFileName
      }
    }
    if (reservation.kind === 'in-progress') {
      return {
        kind: 'in-progress',
        downloadId: reservation.record.downloadId
      }
    }
    return {
      kind: 'duplicate',
      downloadId: reservation.record.downloadId,
      finalPath: reservation.record.finalPath,
      sha256: reservation.record.sha256,
      size: reservation.record.size
    }
  }

  private async drainQueuedEvents(): Promise<void> {
    while (this.queuedEvents.length > 0 && !isTerminalRuntime(this.runtime)) {
      const event = this.queuedEvents.shift()
      if (!event) {
        break
      }
      this.setRuntime(await this.engine.handleEvent(event))
    }
  }

  private startTicker(): void {
    this.stopTicker()
    this.ticker = setInterval(() => {
      if (this.tickInFlight || this.disposed) {
        return
      }
      this.tickInFlight = true
      void this.engine
        .tick()
        .then((runtime) => this.setRuntime(runtime))
        .catch((error: unknown) =>
          this.fail('unknown', formatError(error))
            .then(() => undefined)
            .catch(() => undefined)
        )
        .finally(() => {
          this.tickInFlight = false
        })
    }, 1_000)
    this.ticker.unref()
  }

  private stopTicker(): void {
    if (this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }
    this.tickInFlight = false
  }

  private setRuntime(runtime: ProjectRuntimeRecord): void {
    this.runtime = structuredClone(runtime)
    this.options.onRuntimeChanged?.(this.getRuntime())
    this.notifyTerminalIfNeeded()
  }

  private notifyTerminalIfNeeded(afterStart = false): void {
    if (!isTerminalRuntime(this.runtime) || this.terminalNotified) {
      return
    }
    if (this.starting || this.lifecycleTransition) {
      return
    }
    this.terminalNotified = true
    this.stopTicker()
    const notify = (): void => {
      if (this.disposed) {
        return
      }
      void Promise.resolve(
        this.options.onTerminal?.(this.getRuntime())
      ).catch(() => undefined)
    }
    if (afterStart) {
      this.terminalTimer = setTimeout(() => {
        this.terminalTimer = null
        notify()
      }, 0)
    } else {
      queueMicrotask(notify)
    }
  }

  private assertAvailable(): void {
    if (this.disposed) {
      throw new Error('后台 Project Runtime 已停止')
    }
  }
}

function parseDownloadIntentPayload(value: unknown): {
  businessItemId: string
  attachmentId: string
  sourceUrl: string
  originalFileName: string
  mime?: string
  expectedBytes: number | null
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  const allowedKeys = new Set([
    'businessItemId',
    'attachmentId',
    'sourceUrl',
    'fileName',
    'mime',
    'expectedBytes'
  ])
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    return null
  }
  const required = [
    record.businessItemId,
    record.attachmentId,
    record.sourceUrl,
    record.fileName
  ]
  if (
    required.some(
      (item) =>
        typeof item !== 'string' || item.trim().length === 0
    ) ||
    (record.mime !== undefined &&
      (typeof record.mime !== 'string' ||
        record.mime.trim().length === 0)) ||
    (record.expectedBytes !== undefined &&
      (!Number.isSafeInteger(record.expectedBytes) ||
        (record.expectedBytes as number) < 0))
  ) {
    return null
  }
  try {
    const sourceUrl = new URL(record.sourceUrl as string)
    if (
      sourceUrl.protocol !== 'http:' &&
      sourceUrl.protocol !== 'https:'
    ) {
      return null
    }
    return {
      businessItemId: record.businessItemId as string,
      attachmentId: record.attachmentId as string,
      sourceUrl: sourceUrl.toString(),
      originalFileName: record.fileName as string,
      ...(typeof record.mime === 'string'
        ? { mime: record.mime }
        : {}),
      expectedBytes:
        record.expectedBytes === undefined
          ? null
          : (record.expectedBytes as number)
    }
  } catch {
    return null
  }
}

function normalizeComparableUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    return url.toString()
  } catch {
    return value
  }
}

function isTerminalRuntime(runtime: ProjectRuntimeRecord): boolean {
  return (
    runtime.status === 'failed' ||
    runtime.status === 'completed' ||
    runtime.status === 'cancelled'
  )
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
