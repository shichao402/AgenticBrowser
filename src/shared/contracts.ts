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
  navigate: 'browser:navigate',
  reload: 'browser:reload'
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
  navigate(url: string): Promise<BrowserSnapshot>
  reload(options: ReloadOptions): Promise<BrowserSnapshot>
  onBrowserEvent(listener: (event: BrowserEvent) => void): () => void
}
