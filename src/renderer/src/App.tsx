import { FormEvent, useCallback, useEffect, useState } from 'react'

import type { BrowserEvent, BrowserSnapshot } from '../../shared/contracts'

const EVENT_LABELS: Record<BrowserEvent['type'], string> = {
  created: '页面已创建',
  'navigation-started': '开始导航',
  'navigation-finished': '导航完成',
  'load-started': '开始加载',
  'load-finished': '加载完成',
  'load-failed': '加载失败',
  unresponsive: '页面无响应',
  responsive: '页面恢复响应',
  'renderer-gone': 'Renderer 已退出',
  recreated: '页面已重建',
  'checkpoint-saved': '检查点已保存',
  'checkpoint-failed': '检查点保存失败'
}

export function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<BrowserSnapshot | null>(null)
  const [events, setEvents] = useState<BrowserEvent[]>([])
  const [address, setAddress] = useState('https://example.com/')
  const [error, setError] = useState<string | null>(null)

  const refreshSnapshot = useCallback(async (): Promise<void> => {
    const next = await window.agenticBrowser.getSnapshot()
    setSnapshot(next)
    setAddress(next.url)
  }, [])

  useEffect(() => {
    void refreshSnapshot()

    return window.agenticBrowser.onBrowserEvent((event) => {
      setEvents((current) => [event, ...current].slice(0, 12))
      void refreshSnapshot()
    })
  }, [refreshSnapshot])

  const navigate = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setError(null)

    try {
      const next = await window.agenticBrowser.navigate(address)
      setSnapshot(next)
      setAddress(next.url)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const reload = async (ignoreCache: boolean): Promise<void> => {
    setError(null)

    try {
      const next = await window.agenticBrowser.reload({ ignoreCache })
      setSnapshot(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <header className="brand">
          <span className="brand-mark">AB</span>
          <div>
            <h1>AgenticBrowser</h1>
            <p>Phase 0 · Browser Spike</p>
          </div>
        </header>

        <nav className="section-tabs" aria-label="工作台模块">
          <button className="section-tab section-tab-active" type="button">
            项目
          </button>
          <button className="section-tab" type="button">
            策略
          </button>
          <button className="section-tab" type="button">
            过滤器
          </button>
        </nav>

        <section className="project-card">
          <div className="project-card-heading">
            <div>
              <span className="eyebrow">当前项目</span>
              <h2>Electron 能力验证</h2>
            </div>
            <span className="status-dot" title="运行中" />
          </div>

          <dl className="metric-grid">
            <div>
              <dt>页面代次</dt>
              <dd>{snapshot?.generation ?? '—'}</dd>
            </div>
            <div>
              <dt>响应状态</dt>
              <dd>{snapshot?.responsive === false ? '异常' : '正常'}</dd>
            </div>
            <div>
              <dt>加载状态</dt>
              <dd>{snapshot?.loading ? '加载中' : '空闲'}</dd>
            </div>
            <div>
              <dt>策略运行</dt>
              <dd>0</dd>
            </div>
          </dl>
        </section>

        <section className="event-panel">
          <div className="panel-heading">
            <h2>生命周期事件</h2>
            <span>{events.length}</span>
          </div>

          <ol className="event-list">
            {events.length === 0 ? (
              <li className="event-empty">等待浏览器事件</li>
            ) : (
              events.map((event) => (
                <li key={event.sequence}>
                  <div>
                    <strong>{EVENT_LABELS[event.type]}</strong>
                    <time>{new Date(event.timestamp).toLocaleTimeString()}</time>
                  </div>
                  {event.detail ? <p>{event.detail}</p> : null}
                </li>
              ))
            )}
          </ol>
        </section>
      </aside>

      <header className="toolbar">
        <form onSubmit={(event) => void navigate(event)}>
          <input
            aria-label="地址"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            spellCheck={false}
          />
          <button type="submit">打开</button>
        </form>
        <button type="button" onClick={() => void reload(false)}>
          刷新
        </button>
        <button type="button" onClick={() => void reload(true)}>
          忽略缓存
        </button>
        {error ? <p className="toolbar-error">{error}</p> : null}
      </header>

      <section className="browser-placeholder" aria-label="内嵌浏览器区域">
        <p>WebContentsView 正在初始化</p>
      </section>
    </main>
  )
}
