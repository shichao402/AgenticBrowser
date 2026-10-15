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
import { normalizeNavigationUrl } from './navigation'

const DEFAULT_URL = 'https://example.com/'
const PROFILE_PARTITION = 'persist:profile-default'
export const REMOTE_PAGE_SECURITY = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false
} as const

export interface BrowserDiagnostics {
  shellWebContentsId: number
  pageWebContentsId: number
  distinctWebContents: boolean
  preferences: {
    sandbox: boolean
    contextIsolation: boolean
    nodeIntegration: boolean
  }
  pageWorld: {
    hasNodeProcess: boolean
    hasRequire: boolean
  }
  generation: number
}

export class BrowserSupervisor {
  private readonly profileSession: Session
  private pageView: WebContentsView | null = null
  private bounds: Rectangle = { x: 320, y: 72, width: 960, height: 728 }
  private currentUrl = DEFAULT_URL
  private generation = 0
  private sequence = 0
  private responsive = true
  private lastEvent: BrowserEvent | null = null
  private disposed = false

  constructor(
    private readonly window: BaseWindow,
    private readonly publish: (event: BrowserEvent) => void
  ) {
    this.profileSession = session.fromPartition(PROFILE_PARTITION, {
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
      generation: this.generation
    }
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
        session: this.profileSession
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
