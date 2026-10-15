import type { BaseWindow, Rectangle } from 'electron'

import type {
  BrowserEvent,
  BrowserSnapshot,
  BrowserTab,
  CapabilityPolicy,
  CapabilityPolicySnapshot,
  DownloadSummary,
  ReloadOptions,
  StrategyDefinition,
  StrategyRuntimeSnapshot
} from '../shared/contracts'
import {
  BrowserSupervisor,
  type BrowserDiagnostics,
  type BrowserSupervisorOptions,
  type CaptureBenchmark,
  type FrameDiagnostics,
  type HeartbeatStallProbe,
  type InteractionCaptureBenchmark,
  type MultiViewCaptureBenchmark
} from './browser-supervisor'
import type { BrowserCheckpoint } from './checkpoint-store'
import {
  normalizeCapabilityOrigin,
  resolveCapabilitySettings
} from './capability-store'

interface TabRuntime {
  id: string
  supervisor: BrowserSupervisor
}

export class BrowserTabManager {
  private readonly tabs = new Map<string, TabRuntime>()
  private activeTabId = ''
  private sessionHandlerOwnerId = ''
  private permissionHandlerOwnerId = ''
  private sequence = 0
  private tabSequence = 0
  private strategyDefinitions: StrategyDefinition[]
  private allowedStrategyIds: ReadonlySet<string>
  private readonly quarantinedStrategyIds: Set<string>
  private bounds: Rectangle = { x: 320, y: 104, width: 960, height: 696 }

  constructor(
    private readonly window: BaseWindow,
    private readonly publish: (event: BrowserEvent) => void,
    private readonly options: BrowserSupervisorOptions = {}
  ) {
    this.strategyDefinitions = [...(options.strategyDefinitions ?? [])]
    this.allowedStrategyIds = new Set(options.allowedStrategyIds ?? [])
    this.quarantinedStrategyIds =
      options.quarantinedStrategyIds ?? new Set<string>()
  }

  async start(): Promise<void> {
    const tab = this.createRuntime(this.options.initialUrl)
    this.activeTabId = tab.id
    this.sessionHandlerOwnerId = tab.id
    await tab.supervisor.start()
    tab.supervisor.setBounds(this.bounds)
  }

  setBounds(bounds: Rectangle): void {
    this.bounds = bounds
    for (const tab of this.tabs.values()) {
      tab.supervisor.setBounds(bounds)
    }
  }

  getSnapshot(): BrowserSnapshot {
    return this.activeSupervisor().getSnapshot()
  }

  listTabs(): BrowserTab[] {
    return [...this.tabs.values()].map(({ id, supervisor }) => {
      const snapshot = supervisor.getSnapshot()
      return {
        id,
        title: snapshot.title || getUrlLabel(snapshot.url),
        url: snapshot.url,
        active: id === this.activeTabId,
        loading: snapshot.loading,
        responsive: snapshot.responsive
      }
    })
  }

  async createTab(url?: string): Promise<BrowserTab[]> {
    if (this.tabs.size >= 8) {
      throw new Error('Phase 1 最多同时打开 8 个标签页')
    }

    const previous = this.activeSupervisor()
    previous.setVisible(false)
    const tab = this.createRuntime(url ?? 'https://example.com/')
    this.activeTabId = tab.id

    try {
      await tab.supervisor.start()
      tab.supervisor.setBounds(this.bounds)
      tab.supervisor.setVisible(true)
      await this.persistActiveTab('tab-created')
    } catch (error) {
      this.tabs.delete(tab.id)
      tab.supervisor.dispose()
      this.activeTabId = this.findTabId(previous)
      previous.takePermissionHandlerOwnership()
      this.permissionHandlerOwnerId = this.activeTabId
      previous.setVisible(true)
      throw error
    }

    return this.listTabs()
  }

  switchTab(tabId: string): BrowserTab[] {
    const next = this.requireTab(tabId)
    if (tabId === this.activeTabId) {
      return this.listTabs()
    }

    this.activeSupervisor().setVisible(false)
    this.activeTabId = tabId
    next.supervisor.setBounds(this.bounds)
    next.supervisor.setVisible(true)
    void this.persistActiveTab('tab-switched')
    return this.listTabs()
  }

  closeTab(tabId: string): BrowserTab[] {
    if (this.tabs.size === 1) {
      throw new Error('至少保留一个标签页')
    }

    const tab = this.requireTab(tabId)
    const remaining = [...this.tabs.values()].filter((entry) => entry.id !== tabId)
    if (tabId === this.sessionHandlerOwnerId) {
      const nextOwner = remaining[0]
      if (!nextOwner) {
        throw new Error('无法转移 session handler')
      }
      tab.supervisor.setSessionHandlerOwnership(false)
      nextOwner.supervisor.setSessionHandlerOwnership(true)
      this.sessionHandlerOwnerId = nextOwner.id
    }
    if (tabId === this.permissionHandlerOwnerId) {
      const nextOwner = remaining[0]
      if (!nextOwner) {
        throw new Error('无法转移 permission handler')
      }
      nextOwner.supervisor.takePermissionHandlerOwnership()
      this.permissionHandlerOwnerId = nextOwner.id
    }

    const wasActive = tabId === this.activeTabId
    this.tabs.delete(tabId)
    tab.supervisor.dispose()

    if (wasActive) {
      const next = remaining[0]
      if (!next) {
        throw new Error('关闭标签页后没有可激活页面')
      }
      this.activeTabId = next.id
      next.supervisor.setBounds(this.bounds)
      next.supervisor.setVisible(true)
    }
    void this.persistActiveTab('tab-closed')

    return this.listTabs()
  }

  getCapabilityPolicy(): CapabilityPolicy {
    return this.activeSupervisor().getCapabilityPolicy()
  }

  getCapabilityPolicySnapshot(): CapabilityPolicySnapshot {
    const supervisor = this.activeSupervisor()
    const policy = supervisor.getCapabilityPolicy()
    const currentOrigin = normalizeCapabilityOrigin(
      supervisor.getSnapshot().url
    )
    return {
      policy,
      currentOrigin,
      effective: resolveCapabilitySettings(policy, currentOrigin)
    }
  }

  setCapabilityPolicy(policy: CapabilityPolicy): CapabilityPolicySnapshot {
    for (const tab of this.tabs.values()) {
      tab.supervisor.setCapabilityPolicy(policy)
    }
    return this.getCapabilityPolicySnapshot()
  }

  getDownloadSummary(): DownloadSummary {
    return [...this.tabs.values()].reduce<DownloadSummary>(
      (summary, tab) => {
        const downloads = tab.supervisor.getDownloadSummary()
        summary.active += downloads.active
        summary.completed += downloads.completed
        summary.failed += downloads.failed
        summary.receivedBytes += downloads.receivedBytes
        return summary
      },
      {
        active: 0,
        completed: 0,
        failed: 0,
        receivedBytes: 0
      }
    )
  }

  getStrategyRuntimeSnapshot(): StrategyRuntimeSnapshot {
    const snapshots = [...this.tabs.values()].map((tab) =>
      tab.supervisor.getStrategyRuntimeSnapshot()
    )
    return {
      activeCount: snapshots.reduce(
        (total, snapshot) => total + snapshot.activeCount,
        0
      ),
      quarantinedStrategyIds: [
        ...new Set(
          snapshots.flatMap(
            (snapshot) => snapshot.quarantinedStrategyIds
          )
        )
      ].sort(),
      entries: snapshots.flatMap((snapshot) => snapshot.entries)
    }
  }

  async setStrategyConfiguration(
    definitions: StrategyDefinition[],
    allowedStrategyIds: ReadonlySet<string>
  ): Promise<void> {
    this.strategyDefinitions = [...definitions]
    this.allowedStrategyIds = new Set(allowedStrategyIds)
    await Promise.all(
      [...this.tabs.values()].map((tab) =>
        tab.supervisor.setStrategyConfiguration(
          this.strategyDefinitions,
          this.allowedStrategyIds
        )
      )
    )
  }

  navigate(input: string): Promise<BrowserSnapshot> {
    return this.activeSupervisor().navigate(input)
  }

  reload(options: ReloadOptions): Promise<BrowserSnapshot> {
    return this.activeSupervisor().reload(options)
  }

  requestDownload(url: string): void {
    this.activeSupervisor().requestDownload(url)
  }

  triggerPopup(url: string): Promise<void> {
    return this.activeSupervisor().triggerPopup(url)
  }

  queryPermissionForDiagnostics(
    permission: 'geolocation' | 'notifications'
  ): Promise<string> {
    return this.activeSupervisor().queryPermissionForDiagnostics(permission)
  }

  collectDiagnostics(shellWebContentsId: number): Promise<BrowserDiagnostics> {
    return this.activeSupervisor().collectDiagnostics(shellWebContentsId)
  }

  collectFrameDiagnostics(): Promise<FrameDiagnostics[]> {
    return this.activeSupervisor().collectFrameDiagnostics()
  }

  hasProfileCookie(name: string): Promise<boolean> {
    return this.activeSupervisor().hasProfileCookie(name)
  }

  setProfileCookieForDiagnostics(
    name: string,
    value: string
  ): Promise<void> {
    return this.activeSupervisor().setProfileCookieForDiagnostics(name, value)
  }

  benchmarkCapture(frameCount?: number, intervalMs?: number): Promise<CaptureBenchmark> {
    return this.activeSupervisor().benchmarkCapture(frameCount, intervalMs)
  }

  benchmarkInteractionDuringCapture(
    sampleCount?: number
  ): Promise<InteractionCaptureBenchmark> {
    return this.activeSupervisor().benchmarkInteractionDuringCapture(sampleCount)
  }

  benchmarkMultiViewCapture(
    frameCount?: number,
    intervalMs?: number
  ): Promise<MultiViewCaptureBenchmark> {
    return this.activeSupervisor().benchmarkMultiViewCapture(frameCount, intervalMs)
  }

  probeHeartbeatStall(
    blockMs?: number,
    timeoutMs?: number
  ): Promise<HeartbeatStallProbe> {
    return this.activeSupervisor().probeHeartbeatStall(blockMs, timeoutMs)
  }

  forceCrashAndWait(timeoutMs?: number): Promise<void> {
    return this.activeSupervisor().forceCrashAndWait(timeoutMs)
  }

  flushCheckpoint(reason: string): Promise<BrowserCheckpoint | null> {
    return this.persistActiveTab(reason)
  }

  async prepareForShutdown(): Promise<void> {
    await Promise.all(
      [...this.tabs.values()].map((tab) =>
        tab.supervisor.prepareForShutdown()
      )
    )
  }

  dispose(windowClosed = false): void {
    for (const tab of this.tabs.values()) {
      tab.supervisor.dispose(windowClosed)
    }
    this.tabs.clear()
  }

  private createRuntime(initialUrl?: string): TabRuntime {
    const id = `tab-${++this.tabSequence}`
    const isFirst = this.tabs.size === 0
    const {
      initialUrl: _initialUrl,
      checkpointStore,
      manageSessionHandlers: _manageSessionHandlers,
      ...sharedOptions
    } = this.options
    const supervisor = new BrowserSupervisor(
      this.window,
      (event) => {
        if (!this.tabs.has(id)) {
          return
        }
        this.publish({
          ...event,
          sequence: ++this.sequence,
          tabId: id
        })
      },
      {
        ...sharedOptions,
        strategyDefinitions: this.strategyDefinitions,
        allowedStrategyIds: this.allowedStrategyIds,
        quarantinedStrategyIds: this.quarantinedStrategyIds,
        ...(initialUrl ?? _initialUrl
          ? { initialUrl: initialUrl ?? _initialUrl }
          : {}),
        ...(isFirst && checkpointStore ? { checkpointStore } : {}),
        manageSessionHandlers: isFirst
      }
    )
    this.permissionHandlerOwnerId = id
    const tab = { id, supervisor }
    this.tabs.set(id, tab)
    return tab
  }

  private activeSupervisor(): BrowserSupervisor {
    return this.requireTab(this.activeTabId).supervisor
  }

  private requireTab(tabId: string): TabRuntime {
    const tab = this.tabs.get(tabId)
    if (!tab) {
      throw new Error(`标签页不存在：${tabId}`)
    }
    return tab
  }

  private findTabId(supervisor: BrowserSupervisor): string {
    for (const tab of this.tabs.values()) {
      if (tab.supervisor === supervisor) {
        return tab.id
      }
    }
    throw new Error('找不到 BrowserSupervisor 对应标签页')
  }

  private async persistActiveTab(
    reason: string
  ): Promise<BrowserCheckpoint | null> {
    if (!this.options.checkpointStore) {
      return this.activeSupervisor().flushCheckpoint(reason)
    }

    return this.options.checkpointStore.write({
      profileId: this.options.profileId ?? 'profile-default',
      url: this.activeSupervisor().getSnapshot().url,
      reason
    })
  }
}

function getUrlLabel(url: string): string {
  try {
    return new URL(url).hostname || '新标签页'
  } catch {
    return '新标签页'
  }
}
