import { FormEvent, useCallback, useEffect, useState } from 'react'

import type {
  BrowserEvent,
  BrowserSnapshot,
  BrowserTab,
  CapabilitySettings,
  MonitorSnapshot,
  ProfileSummary
} from '../../shared/contracts'

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
  'checkpoint-failed': '检查点保存失败',
  'health-changed': '健康状态变化',
  'recovery-scheduled': '恢复已排队',
  'recovery-started': '开始恢复',
  'recovery-succeeded': '恢复成功',
  'circuit-open': '恢复熔断',
  'popup-blocked': '弹窗已拦截',
  'popup-routed': '弹窗已转入当前页',
  'download-blocked': '下载已拦截',
  'download-started': '下载开始',
  'download-progress': '下载进度',
  'download-completed': '下载完成',
  'download-failed': '下载失败'
}

const CAPABILITY_ITEMS: Array<{
  key: keyof CapabilitySettings
  label: string
}> = [
  { key: 'downloads', label: '下载' },
  { key: 'popups', label: '弹窗转入当前页' },
  { key: 'notifications', label: '通知' },
  { key: 'geolocation', label: '定位' },
  { key: 'media', label: '摄像头/麦克风' },
  { key: 'clipboardRead', label: '读取剪贴板' },
  { key: 'fullscreen', label: '全屏' }
]

export function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<BrowserSnapshot | null>(null)
  const [monitor, setMonitor] = useState<MonitorSnapshot | null>(null)
  const [capabilities, setCapabilities] =
    useState<CapabilitySettings | null>(null)
  const [tabs, setTabs] = useState<BrowserTab[]>([])
  const [profiles, setProfiles] = useState<ProfileSummary[]>([])
  const [newProfileName, setNewProfileName] = useState('')
  const [events, setEvents] = useState<BrowserEvent[]>([])
  const [address, setAddress] = useState('https://example.com/')
  const [error, setError] = useState<string | null>(null)

  const refreshSnapshot = useCallback(async (): Promise<void> => {
    const next = await window.agenticBrowser.getSnapshot()
    setSnapshot(next)
    setAddress(next.url)
  }, [])

  const refreshMonitor = useCallback(async (): Promise<void> => {
    setMonitor(await window.agenticBrowser.getMonitorSnapshot())
  }, [])

  const refreshCapabilities = useCallback(async (): Promise<void> => {
    setCapabilities(await window.agenticBrowser.getCapabilities())
  }, [])

  const refreshTabs = useCallback(async (): Promise<void> => {
    setTabs(await window.agenticBrowser.listTabs())
  }, [])

  const refreshProfiles = useCallback(async (): Promise<void> => {
    setProfiles(await window.agenticBrowser.listProfiles())
  }, [])

  useEffect(() => {
    void Promise.all([
      refreshSnapshot(),
      refreshMonitor(),
      refreshCapabilities(),
      refreshTabs(),
      refreshProfiles()
    ]).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })

    return window.agenticBrowser.onBrowserEvent((event) => {
      setEvents((current) => [event, ...current].slice(0, 12))
      void Promise.all([
        refreshSnapshot(),
        refreshMonitor(),
        refreshTabs()
      ]).catch(
        (cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      )
    })
  }, [
    refreshCapabilities,
    refreshMonitor,
    refreshProfiles,
    refreshSnapshot,
    refreshTabs
  ])

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshMonitor().catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
    }, 2_000)
    return () => window.clearInterval(timer)
  }, [refreshMonitor])

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

  const toggleCapability = async (
    key: keyof CapabilitySettings
  ): Promise<void> => {
    if (!capabilities) {
      return
    }

    try {
      setCapabilities(
        await window.agenticBrowser.setCapabilities({
          ...capabilities,
          [key]: !capabilities[key]
        })
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const createTab = async (): Promise<void> => {
    try {
      setTabs(await window.agenticBrowser.createTab())
      await refreshSnapshot()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const switchTab = async (tabId: string): Promise<void> => {
    try {
      setTabs(await window.agenticBrowser.switchTab(tabId))
      await refreshSnapshot()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const closeTab = async (tabId: string): Promise<void> => {
    try {
      setTabs(await window.agenticBrowser.closeTab(tabId))
      await refreshSnapshot()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const createProfile = async (): Promise<void> => {
    if (newProfileName.trim().length === 0) {
      return
    }
    try {
      setProfiles(
        await window.agenticBrowser.createProfile(newProfileName)
      )
      setNewProfileName('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const activateProfile = async (profileId: string): Promise<void> => {
    try {
      setProfiles(await window.agenticBrowser.activateProfile(profileId))
      await Promise.all([refreshTabs(), refreshSnapshot(), refreshMonitor()])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const deleteProfile = async (profileId: string): Promise<void> => {
    try {
      setProfiles(await window.agenticBrowser.deleteProfile(profileId))
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
            <p>Phase 1 · Supervised Browser</p>
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

        <section className="profile-panel">
          <div className="panel-heading">
            <h2>Profile</h2>
            <span>切换会重建 tabs</span>
          </div>
          <select
            aria-label="活动 Profile"
            value={profiles.find((profile) => profile.active)?.id ?? ''}
            onChange={(event) => void activateProfile(event.target.value)}
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
          <div className="profile-create">
            <input
              aria-label="新 Profile 名称"
              placeholder="新 Profile"
              value={newProfileName}
              onChange={(event) => setNewProfileName(event.target.value)}
            />
            <button type="button" onClick={() => void createProfile()}>
              添加
            </button>
          </div>
          {profiles.some(
            (profile) => !profile.active && profile.id !== 'profile-default'
          ) ? (
            <div className="profile-delete-list">
              {profiles
                .filter(
                  (profile) =>
                    !profile.active && profile.id !== 'profile-default'
                )
                .map((profile) => (
                  <button
                    key={profile.id}
                    type="button"
                    title={`删除 ${profile.name}`}
                    onClick={() => void deleteProfile(profile.id)}
                  >
                    删除 {profile.name}
                  </button>
                ))}
            </div>
          ) : null}
        </section>

        <section className="project-card">
          <div className="project-card-heading">
            <div>
              <span className="eyebrow">当前项目</span>
              <h2>Electron 能力验证</h2>
            </div>
            <span
              className={`status-dot ${
                snapshot?.health.status === 'healthy'
                  ? ''
                  : 'status-dot-warning'
              }`}
              title={snapshot?.health.status ?? '初始化'}
            />
          </div>

          <dl className="metric-grid">
            <div>
              <dt>页面代次</dt>
              <dd>{snapshot?.generation ?? '—'}</dd>
            </div>
            <div>
              <dt>页面健康</dt>
              <dd>{snapshot?.health.status ?? '—'}</dd>
            </div>
            <div>
              <dt>恢复状态</dt>
              <dd>{snapshot?.recovery.status ?? '—'}</dd>
            </div>
            <div>
              <dt>策略运行</dt>
              <dd>{monitor?.activeStrategyCount ?? '—'}</dd>
            </div>
            <div>
              <dt>活动下载</dt>
              <dd>{monitor?.downloads.active ?? '—'}</dd>
            </div>
            <div>
              <dt>Chromium 进程</dt>
              <dd>{monitor?.processes.length ?? '—'}</dd>
            </div>
            <div>
              <dt>CPU</dt>
              <dd>
                {monitor ? `${monitor.totalCpuPercent.toFixed(1)}%` : '—'}
              </dd>
            </div>
            <div>
              <dt>工作集</dt>
              <dd>{formatBytes(monitor?.totalWorkingSetBytes)}</dd>
            </div>
            <div>
              <dt>最后响应</dt>
              <dd>{formatTime(snapshot?.health.lastResponseAt)}</dd>
            </div>
          </dl>
        </section>

        <section className="capability-panel">
          <div className="panel-heading">
            <h2>能力中心</h2>
            <span>默认拒绝</span>
          </div>
          <div className="capability-list">
            {CAPABILITY_ITEMS.map((item) => (
              <label key={item.key}>
                <span>{item.label}</span>
                <input
                  type="checkbox"
                  checked={capabilities?.[item.key] ?? false}
                  disabled={!capabilities}
                  onChange={() => void toggleCapability(item.key)}
                />
              </label>
            ))}
          </div>
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
        <div className="tab-strip" role="tablist" aria-label="浏览器标签页">
          {tabs.map((tab) => (
            <div
              className={`browser-tab ${tab.active ? 'browser-tab-active' : ''}`}
              key={tab.id}
            >
              <button
                type="button"
                role="tab"
                aria-selected={tab.active}
                title={tab.url}
                onClick={() => void switchTab(tab.id)}
              >
                {tab.title}
              </button>
              <button
                className="tab-close"
                type="button"
                aria-label={`关闭 ${tab.title}`}
                disabled={tabs.length === 1}
                onClick={() => void closeTab(tab.id)}
              >
                ×
              </button>
            </div>
          ))}
          <button
            className="new-tab"
            type="button"
            aria-label="新建标签页"
            onClick={() => void createTab()}
          >
            +
          </button>
        </div>
        <div className="navigation-row">
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
        </div>
        {error ? <p className="toolbar-error">{error}</p> : null}
      </header>

      <section className="browser-placeholder" aria-label="内嵌浏览器区域">
        {snapshot?.recovery.status === 'circuit-open' ? (
          <div className="error-page">
            <span className="eyebrow">Recovery circuit open</span>
            <h2>页面自动恢复已停止</h2>
            <p>{snapshot.recovery.lastReason}</p>
            <p>恢复预算已经耗尽。可在地址栏更换 URL，或手动刷新后重试。</p>
          </div>
        ) : (
          <p>WebContentsView 正在初始化</p>
        )}
      </section>
    </main>
  )
}

function formatBytes(value: number | undefined): string {
  if (value === undefined) {
    return '—'
  }
  return `${(value / (1024 * 1024)).toFixed(0)} MiB`
}

function formatTime(value: string | null | undefined): string {
  if (!value) {
    return '—'
  }
  return new Date(value).toLocaleTimeString()
}
