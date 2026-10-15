export const IPC_CHANNELS = {
  browserEvent: 'browser:event',
  getSnapshot: 'browser:get-snapshot',
  getMonitorSnapshot: 'monitor:get-snapshot',
  getCapabilityPolicy: 'capability:get-policy',
  setCapabilityPolicy: 'capability:set-policy',
  listTabs: 'tabs:list',
  createTab: 'tabs:create',
  switchTab: 'tabs:switch',
  closeTab: 'tabs:close',
  listProfiles: 'profiles:list',
  createProfile: 'profiles:create',
  activateProfile: 'profiles:activate',
  deleteProfile: 'profiles:delete',
  getStartupSettings: 'startup:get',
  setOpenAtLogin: 'startup:set-open-at-login',
  getStrategyWorkspace: 'strategies:get-workspace',
  saveStrategy: 'strategies:save',
  setStrategyEnabled: 'strategies:set-enabled',
  setStrategyAllowed: 'strategies:set-allowed',
  deleteStrategy: 'strategies:delete',
  navigate: 'browser:navigate',
  reload: 'browser:reload'
} as const

export const STRATEGY_IPC_CHANNELS = {
  bootstrap: 'strategy-runtime:bootstrap',
  signal: 'strategy-runtime:signal',
  invoke: 'strategy-runtime:invoke'
} as const

export type BrowserEventType =
  | 'created'
  | 'navigation-started'
  | 'navigation-finished'
  | 'load-started'
  | 'load-finished'
  | 'load-failed'
  | 'unresponsive'
  | 'responsive'
  | 'renderer-gone'
  | 'recreated'
  | 'checkpoint-saved'
  | 'checkpoint-failed'
  | 'health-changed'
  | 'recovery-scheduled'
  | 'recovery-started'
  | 'recovery-succeeded'
  | 'circuit-open'
  | 'popup-blocked'
  | 'popup-routed'
  | 'download-blocked'
  | 'download-started'
  | 'download-progress'
  | 'download-completed'
  | 'download-failed'
  | 'strategy-started'
  | 'strategy-ready'
  | 'strategy-log'
  | 'strategy-event'
  | 'strategy-failed'
  | 'strategy-heartbeat-missed'
  | 'strategy-quarantined'
  | 'strategy-reloaded'

export interface BrowserEvent {
  sequence: number
  type: BrowserEventType
  timestamp: string
  url: string
  detail?: string
  tabId?: string
}

export interface BrowserSnapshot {
  url: string
  title: string
  loading: boolean
  responsive: boolean
  generation: number
  lastEvent: BrowserEvent | null
  health: PageHealthSnapshot
  recovery: RecoverySnapshot
}

export type PageHealthStatus =
  | 'starting'
  | 'healthy'
  | 'degraded'
  | 'unresponsive'
  | 'stopped'

export interface PageHealthSnapshot {
  status: PageHealthStatus
  lastProbeAt: string | null
  lastResponseAt: string | null
  consecutiveFailures: number
}

export interface RecoverySnapshot {
  status: 'idle' | 'scheduled' | 'recovering' | 'circuit-open'
  attemptsInWindow: number
  lastAction: string | null
  lastReason: string | null
  lastRecoveryAt: string | null
}

export interface ReloadOptions {
  ignoreCache: boolean
}

export interface ProcessMetric {
  pid: number
  type: string
  cpuPercent: number
  workingSetBytes: number
}

export interface MonitorSnapshot {
  generatedAt: string
  browser: BrowserSnapshot
  browserEventCount: number
  activePageCount: number
  activeStrategyCount: number
  strategies: StrategyRuntimeSnapshot
  totalCpuPercent: number
  totalWorkingSetBytes: number
  processes: ProcessMetric[]
  downloads: DownloadSummary
}

export interface DownloadSummary {
  active: number
  completed: number
  failed: number
  receivedBytes: number
}

export interface BrowserTab {
  id: string
  title: string
  url: string
  active: boolean
  loading: boolean
  responsive: boolean
}

export interface ProfileSummary {
  id: string
  name: string
  createdAt: string
  active: boolean
}

export interface CapabilitySettings {
  popups: boolean
  downloads: boolean
  notifications: boolean
  geolocation: boolean
  media: boolean
  clipboardRead: boolean
  fullscreen: boolean
}

export interface OriginCapabilityRule {
  origin: string
  overrides: Partial<CapabilitySettings>
}

export interface CapabilityPolicy {
  schemaVersion: 1
  defaults: CapabilitySettings
  origins: OriginCapabilityRule[]
}

export interface CapabilityPolicySnapshot {
  policy: CapabilityPolicy
  currentOrigin: string | null
  effective: CapabilitySettings
}

export interface StartupSettings {
  supported: boolean
  openAtLogin: boolean
  managedByWatchdog: boolean
}

export type StrategyRunAt =
  | 'document-start'
  | 'document-end'
  | 'document-idle'

export type StrategyFrameScope = 'top' | 'all'

export type StrategyPermission =
  | 'dom.read'
  | 'dom.write'
  | 'dom.click'
  | 'config.read'
  | 'log'
  | 'project.emit-event'
  | 'network.request'
  | 'main-world'

export interface StrategyManifest {
  id: string
  name: string
  version: string
  matches: string[]
  excludes: string[]
  runAt: StrategyRunAt
  frames: StrategyFrameScope
  permissions: StrategyPermission[]
  networkMatches: string[]
  config: Record<string, JsonValue>
  timeouts: {
    startupMs: number
    heartbeatMs: number
  }
}

export interface StrategyDefinition {
  manifest: StrategyManifest
  source: string
  enabled: boolean
  updatedAt: string
}

export interface StrategyDraft {
  manifest: StrategyManifest
  source: string
  enabled: boolean
}

export interface StrategyWorkspaceSnapshot {
  strategies: StrategyDefinition[]
  developmentAllowedStrategyIds: string[]
}

export type StrategyRuntimeStatus =
  | 'issued'
  | 'scheduled'
  | 'starting'
  | 'running'
  | 'failed'

export interface StrategyRuntimeEntrySnapshot {
  strategyId: string
  name: string
  version: string
  url: string
  isMainFrame: boolean
  status: StrategyRuntimeStatus
  startedAt: string | null
  lastHeartbeatAt: string | null
  failure: string | null
}

export interface StrategyRuntimeSnapshot {
  activeCount: number
  quarantinedStrategyIds: string[]
  entries: StrategyRuntimeEntrySnapshot[]
}

export interface StrategyBootstrapRequest {
  href: string
  isMainFrame: boolean
}

export interface StrategyBootstrapEntry {
  token: string
  worldId: number
  strategyId: string
  version: string
  runAt: StrategyRunAt
  permissions: StrategyPermission[]
  source: string
  config: Record<string, JsonValue>
  startupMs: number
  heartbeatMs: number
}

export interface StrategyBootstrapResponse {
  entries: StrategyBootstrapEntry[]
}

export type StrategyRuntimeSignalType =
  | 'installed'
  | 'started'
  | 'ready'
  | 'heartbeat'
  | 'failed'

export interface StrategyRuntimeSignal {
  token: string
  type: StrategyRuntimeSignalType
  detail?: string
}

export type StrategyLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface StrategyNetworkRequest {
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  headers?: Record<string, string>
  body?: string
}

export interface StrategyNetworkResponse {
  url: string
  status: number
  headers: Record<string, string>
  body: string
}

export type StrategyHostMethod =
  | 'log'
  | 'emit-event'
  | 'network-request'
  | 'main-world-eval'

export interface StrategyHostCall {
  token: string
  method: StrategyHostMethod
  payload: JsonValue
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface BrowserShellApi {
  getSnapshot(): Promise<BrowserSnapshot>
  getMonitorSnapshot(): Promise<MonitorSnapshot>
  getCapabilityPolicy(): Promise<CapabilityPolicySnapshot>
  setCapabilityPolicy(
    policy: CapabilityPolicy
  ): Promise<CapabilityPolicySnapshot>
  listTabs(): Promise<BrowserTab[]>
  createTab(url?: string): Promise<BrowserTab[]>
  switchTab(tabId: string): Promise<BrowserTab[]>
  closeTab(tabId: string): Promise<BrowserTab[]>
  listProfiles(): Promise<ProfileSummary[]>
  createProfile(name: string): Promise<ProfileSummary[]>
  activateProfile(profileId: string): Promise<ProfileSummary[]>
  deleteProfile(profileId: string): Promise<ProfileSummary[]>
  getStartupSettings(): Promise<StartupSettings>
  setOpenAtLogin(enabled: boolean): Promise<StartupSettings>
  getStrategyWorkspace(): Promise<StrategyWorkspaceSnapshot>
  saveStrategy(draft: StrategyDraft): Promise<StrategyWorkspaceSnapshot>
  setStrategyEnabled(
    strategyId: string,
    enabled: boolean
  ): Promise<StrategyWorkspaceSnapshot>
  setStrategyAllowed(
    strategyId: string,
    allowed: boolean
  ): Promise<StrategyWorkspaceSnapshot>
  deleteStrategy(strategyId: string): Promise<StrategyWorkspaceSnapshot>
  navigate(url: string): Promise<BrowserSnapshot>
  reload(options: ReloadOptions): Promise<BrowserSnapshot>
  onBrowserEvent(listener: (event: BrowserEvent) => void): () => void
}
