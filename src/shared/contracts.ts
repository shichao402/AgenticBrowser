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
  getProjectWorkspace: 'projects:get-workspace',
  installKnowledgePlanetPilot: 'projects:install-knowledge-planet-pilot',
  saveProject: 'projects:save',
  setActiveProject: 'projects:set-active',
  deleteProject: 'projects:delete',
  startProjectRuntime: 'projects:start-runtime',
  pauseProjectRuntime: 'projects:pause-runtime',
  resumeProjectRuntime: 'projects:resume-runtime',
  stopProjectRuntime: 'projects:stop-runtime',
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
  | 'project-runtime-started'
  | 'project-runtime-paused'
  | 'project-runtime-resumed'
  | 'project-runtime-stopped'
  | 'project-runtime-failed'
  | 'filter-hit'
  | 'filter-css-applied'

export interface BrowserEvent {
  sequence: number
  type: BrowserEventType
  timestamp: string
  url: string
  detail?: string
  tabId?: string
  projectId?: string
  runtimeId?: string
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
  projectRuntime: ProjectRuntimeSnapshot | null
  projectRuntimes: ProjectRuntimeSnapshot[]
  activeProjectCount: number
  pausedProjectCount: number
  queuedProjectCount: number
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

export type ProjectRuntimeMode =
  | 'manual'
  | 'autostart'
  | 'resident'
  | 'schedule'

export type ProjectSchedule =
  | {
      kind: 'daily'
      times: string[]
    }
  | {
      kind: 'interval'
      everyMinutes: number
    }

export interface ProjectStrategyPin {
  id: string
  version: string
}

export type ContentFilterResourceType =
  | 'stylesheet'
  | 'image'
  | 'media'
  | 'font'
  | 'script'
  | 'xhr'
  | 'other'

export interface ContentFilterNetworkRule {
  id: string
  action: 'allow' | 'block'
  urlPattern: string
  resourceTypes: ContentFilterResourceType[]
}

export interface ContentFilterCssRule {
  id: string
  urlPattern: string
  selectors: string[]
}

export interface ContentFilterDefinition {
  enabled: boolean
  networkRules: ContentFilterNetworkRule[]
  cssRules: ContentFilterCssRule[]
}

export type WorkflowFailureCategory =
  | 'network'
  | 'timeout'
  | 'authentication'
  | 'page-changed'
  | 'renderer'
  | 'disk'
  | 'cancelled'
  | 'unknown'

export interface WorkflowNodeBase {
  id: string
  timeoutMs: number
  maxAttempts: number
  checkpoint: boolean
  idempotencyKey?: string
  onFailure?: Partial<Record<WorkflowFailureCategory, string>>
}

export type WorkflowNode =
  | (WorkflowNodeBase & {
      kind: 'navigate'
      url: string
      next: string
    })
  | (WorkflowNodeBase & {
      kind: 'wait-for-event'
      eventName: string
      next: string
    })
  | (WorkflowNodeBase & {
      kind: 'delay'
      delayMs: number
      next: string
    })
  | (WorkflowNodeBase & {
      kind: 'complete'
    })

export interface ProjectWorkflowDefinition {
  version: number
  entryNodeId: string
  nodes: WorkflowNode[]
}

export interface ProjectRetryPolicy {
  maxConsecutiveFailures: number
  baseBackoffMs: number
  maxBackoffMs: number
}

export interface ProjectOutputSettings {
  root: string
  maxBytes: number
  fileNameTemplate: string
}

export interface ProjectRuntimeSettings {
  mode: ProjectRuntimeMode
  timezone: string
  schedule?: ProjectSchedule
  priority: number
  maxRunMs: number
}

export interface ProjectDefinition {
  id: string
  name: string
  revision: number
  profileId: string
  startupPages: string[]
  strategies: ProjectStrategyPin[]
  runtime: ProjectRuntimeSettings
  workflow: ProjectWorkflowDefinition
  output: ProjectOutputSettings
  capabilities: CapabilityPolicy
  filter: ContentFilterDefinition
  retry: ProjectRetryPolicy
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface ProjectDraft {
  id: string
  name: string
  profileId: string
  startupPages: string[]
  strategies: ProjectStrategyPin[]
  runtime: ProjectRuntimeSettings
  workflow: ProjectWorkflowDefinition
  output: ProjectOutputSettings
  capabilities: CapabilityPolicy
  filter: ContentFilterDefinition
  retry: ProjectRetryPolicy
  enabled: boolean
}

export type ProjectStrategyResolutionStatus =
  | 'ready'
  | 'missing'
  | 'version-mismatch'
  | 'disabled'

export interface ProjectStrategyResolution {
  strategyId: string
  pinnedVersion: string
  registryVersion: string | null
  status: ProjectStrategyResolutionStatus
  runnable: boolean
}

export interface ProjectWorkspaceSnapshot {
  activeProjectId: string | null
  projects: ProjectDefinition[]
  runtimes: ProjectRuntimeRecord[]
  strategyResolutions: ProjectStrategyResolution[]
}

export type ProjectRuntimeStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'recovering'
  | 'paused'
  | 'failed'
  | 'completed'
  | 'cancelled'

export interface ProjectRuntimeCounters {
  scanned: number
  matched: number
  skipped: number
  downloaded: number
  failed: number
  downloadedBytes: number
}

export interface ProjectRuntimeRecord {
  runtimeId: string
  projectId: string
  projectRevision: number
  trigger: 'manual' | 'autostart' | 'resident' | 'schedule' | 'resume'
  status: ProjectRuntimeStatus
  currentNodeId: string
  nodeAttempt: number
  checkpointNodeId: string | null
  checkpointData: Record<string, JsonValue>
  lastHeartbeatAt: string
  nextWakeAt: string | null
  lastError: string | null
  lastFailureCategory: WorkflowFailureCategory | null
  counters: ProjectRuntimeCounters
  startedAt: string
  updatedAt: string
  completedAt: string | null
}

export type ProjectRuntimeSnapshot = ProjectRuntimeRecord

export type DownloadRecordStatus =
  | 'reserved'
  | 'downloading'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface ProjectDownloadRecord {
  downloadId: string
  idempotencyKey: string
  projectId: string
  runtimeId: string
  workflowNodeId: string
  sourcePage: string
  sourceUrl: string
  businessItemId: string
  attachmentId: string
  originalFileName: string
  safeFileName: string
  temporaryPath: string
  finalPath: string
  mime: string | null
  size: number
  sha256: string | null
  status: DownloadRecordStatus
  retryCount: number
  errorCategory: WorkflowFailureCategory | null
  error: string | null
  startedAt: string
  updatedAt: string
  completedAt: string | null
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

export interface KnowledgePlanetPilotInstallResult {
  projectWorkspace: ProjectWorkspaceSnapshot
  strategyWorkspace: StrategyWorkspaceSnapshot
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
  getProjectWorkspace(): Promise<ProjectWorkspaceSnapshot>
  installKnowledgePlanetPilot(
    profileId: string
  ): Promise<KnowledgePlanetPilotInstallResult>
  saveProject(draft: ProjectDraft): Promise<ProjectWorkspaceSnapshot>
  setActiveProject(projectId: string): Promise<ProjectWorkspaceSnapshot>
  deleteProject(projectId: string): Promise<ProjectWorkspaceSnapshot>
  startProjectRuntime(projectId: string): Promise<ProjectWorkspaceSnapshot>
  pauseProjectRuntime(projectId: string): Promise<ProjectWorkspaceSnapshot>
  resumeProjectRuntime(projectId: string): Promise<ProjectWorkspaceSnapshot>
  stopProjectRuntime(projectId: string): Promise<ProjectWorkspaceSnapshot>
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
