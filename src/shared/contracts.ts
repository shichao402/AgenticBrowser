export const IPC_CHANNELS = {
  browserEvent: 'browser:event',
  getSnapshot: 'browser:get-snapshot',
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

export interface BrowserEvent {
  sequence: number
  type: BrowserEventType
  timestamp: string
  url: string
  detail?: string
}

export interface BrowserSnapshot {
  url: string
  title: string
  loading: boolean
  responsive: boolean
  generation: number
  lastEvent: BrowserEvent | null
}

export interface ReloadOptions {
  ignoreCache: boolean
}

export interface BrowserShellApi {
  getSnapshot(): Promise<BrowserSnapshot>
  navigate(url: string): Promise<BrowserSnapshot>
  reload(options: ReloadOptions): Promise<BrowserSnapshot>
  onBrowserEvent(listener: (event: BrowserEvent) => void): () => void
}
