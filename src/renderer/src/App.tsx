import { type FormEvent, useCallback, useEffect, useState } from 'react'

import type {
  BrowserEvent,
  BrowserSnapshot,
  BrowserTab,
  CapabilityPolicySnapshot,
  CapabilitySettings,
  MonitorSnapshot,
  ProjectWorkspaceSnapshot,
  ProfileSummary,
  StrategyWorkspaceSnapshot,
  StartupSettings
} from '../../shared/contracts'
import { formatBytes, formatTime, isActiveProjectRuntime } from './app-format'
import { currentProfile } from '../../shared/channel-runtime'
import { CapabilityPanel, EventPanel } from './app-panels'
import { ProjectPanel, StrategyPanel } from './app-sections'
import { SettingsPage } from './settings/settings-page'
import type { SettingsTarget } from './settings/settings-page'

export function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<BrowserSnapshot | null>(null)
  const [monitor, setMonitor] = useState<MonitorSnapshot | null>(null)
  const [capabilityPolicy, setCapabilityPolicy] =
    useState<CapabilityPolicySnapshot | null>(null)
  const [tabs, setTabs] = useState<BrowserTab[]>([])
  const [profiles, setProfiles] = useState<ProfileSummary[]>([])
  const [startup, setStartup] = useState<StartupSettings | null>(null)
  const [strategyWorkspace, setStrategyWorkspace] =
    useState<StrategyWorkspaceSnapshot | null>(null)
  const [projectWorkspace, setProjectWorkspace] =
    useState<ProjectWorkspaceSnapshot | null>(null)
  const [activeSection, setActiveSection] = useState<
    'projects' | 'strategies' | 'filters'
  >('projects')
  /** 视图状态：工作台 or 全屏设置页（需求 1.1）。 */
  const [view, setView] = useState<'workbench' | 'settings'>('workbench')
  const [settingsTarget, setSettingsTarget] = useState<SettingsTarget>({
    kind: 'project',
    projectId: null
  })
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

  const refreshCapabilityPolicy = useCallback(async (): Promise<void> => {
    setCapabilityPolicy(await window.agenticBrowser.getCapabilityPolicy())
  }, [])

  const refreshTabs = useCallback(async (): Promise<void> => {
    setTabs(await window.agenticBrowser.listTabs())
  }, [])

  const refreshProfiles = useCallback(async (): Promise<void> => {
    setProfiles(await window.agenticBrowser.listProfiles())
  }, [])

  const refreshStartup = useCallback(async (): Promise<void> => {
    setStartup(await window.agenticBrowser.getStartupSettings())
  }, [])

  const refreshStrategies = useCallback(async (): Promise<void> => {
    setStrategyWorkspace(await window.agenticBrowser.getStrategyWorkspace())
  }, [])

  const refreshProjects = useCallback(async (): Promise<void> => {
    setProjectWorkspace(await window.agenticBrowser.getProjectWorkspace())
  }, [])

  useEffect(() => {
    void Promise.all([
      // refresh* 均为 async，setState 发生在 await 之后，不构成 effect 内同步写状态。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      refreshSnapshot(),
      refreshMonitor(),
      refreshCapabilityPolicy(),
      refreshTabs(),
      refreshProfiles(),
      refreshStartup(),
      refreshStrategies(),
      refreshProjects()
    ]).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })

    return window.agenticBrowser.onBrowserEvent((event) => {
      setEvents((current) => [event, ...current].slice(0, 12))
      const refreshes: Array<Promise<void>> = [
        refreshSnapshot(),
        refreshMonitor(),
        refreshTabs()
      ]
      if (
        event.type === 'created' ||
        event.type === 'recreated' ||
        event.type === 'navigation-finished'
      ) {
        refreshes.push(refreshCapabilityPolicy())
      }
      if (event.type.startsWith('project-runtime-')) {
        refreshes.push(refreshProjects(), refreshProfiles())
      }
      void Promise.all(refreshes).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
    })
  }, [
    refreshCapabilityPolicy,
    refreshMonitor,
    refreshProfiles,
    refreshProjects,
    refreshStrategies,
    refreshStartup,
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

  useEffect(() => {
    // 原生页面视图的层位高于壳层渲染层，必须由主进程切换其可见性，
    // 否则设置页会被内嵌网页整片覆盖（见 main/index.ts 的 applyPageViewVisibility）。
    void window.agenticBrowser
      .setPageViewsVisible(view === 'workbench')
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
  }, [view])

  const navigate = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setError(null)

    try {
      const next = await window.agenticBrowser.navigate(address)
      setSnapshot(next)
      setAddress(next.url)
      await refreshCapabilityPolicy()
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

  const toggleDefaultCapability = async (
    key: keyof CapabilitySettings
  ): Promise<void> => {
    if (!capabilityPolicy) {
      return
    }

    try {
      setCapabilityPolicy(
        await window.agenticBrowser.setCapabilityPolicy({
          ...capabilityPolicy.policy,
          defaults: {
            ...capabilityPolicy.policy.defaults,
            [key]: !capabilityPolicy.policy.defaults[key]
          }
        })
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const setOriginCapability = async (
    key: keyof CapabilitySettings,
    decision: 'inherit' | 'allow' | 'deny'
  ): Promise<void> => {
    const currentOrigin = capabilityPolicy?.currentOrigin
    if (!capabilityPolicy || !currentOrigin) {
      return
    }

    const currentRule = capabilityPolicy.policy.origins.find(
      (rule) => rule.origin === currentOrigin
    )
    const overrides = { ...(currentRule?.overrides ?? {}) }
    if (decision === 'inherit') {
      delete overrides[key]
    } else {
      overrides[key] = decision === 'allow'
    }
    const origins = capabilityPolicy.policy.origins.filter(
      (rule) => rule.origin !== currentOrigin
    )
    if (Object.keys(overrides).length > 0) {
      origins.push({ origin: currentOrigin, overrides })
    }

    try {
      setCapabilityPolicy(
        await window.agenticBrowser.setCapabilityPolicy({
          ...capabilityPolicy.policy,
          origins
        })
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const createTab = async (): Promise<void> => {
    try {
      setTabs(await window.agenticBrowser.createTab())
      await Promise.all([refreshSnapshot(), refreshCapabilityPolicy()])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const switchTab = async (tabId: string): Promise<void> => {
    try {
      setTabs(await window.agenticBrowser.switchTab(tabId))
      await Promise.all([refreshSnapshot(), refreshCapabilityPolicy()])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const closeTab = async (tabId: string): Promise<void> => {
    try {
      setTabs(await window.agenticBrowser.closeTab(tabId))
      await Promise.all([refreshSnapshot(), refreshCapabilityPolicy()])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const createProfile = async (): Promise<void> => {
    if (newProfileName.trim().length === 0) {
      return
    }
    try {
      setProfiles(await window.agenticBrowser.createProfile(newProfileName))
      setNewProfileName('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const activateProfile = async (profileId: string): Promise<void> => {
    try {
      setProfiles(await window.agenticBrowser.activateProfile(profileId))
      await Promise.all([
        refreshTabs(),
        refreshSnapshot(),
        refreshMonitor(),
        refreshCapabilityPolicy()
      ])
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

  const toggleOpenAtLogin = async (): Promise<void> => {
    if (!startup?.supported) {
      return
    }
    try {
      setStartup(
        await window.agenticBrowser.setOpenAtLogin(!startup.openAtLogin)
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const applyProjectWorkspace = (next: ProjectWorkspaceSnapshot): void => {
    setProjectWorkspace(next)
  }

  const selectProject = async (projectId: string): Promise<void> => {
    try {
      const workspace = await window.agenticBrowser.setActiveProject(projectId)
      applyProjectWorkspace(workspace)
      await Promise.all([
        refreshSnapshot(),
        refreshTabs(),
        refreshCapabilityPolicy(),
        refreshMonitor()
      ])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const openProjectSettings = (projectId: string | null): void => {
    setSettingsTarget({ kind: 'project', projectId })
    setView('settings')
  }

  const openStrategySettings = (strategyId: string | null): void => {
    setSettingsTarget({ kind: 'strategy', strategyId })
    setView('settings')
  }

  const newProject = (): void => {
    setActiveSection('projects')
    openProjectSettings(null)
  }

  const installAutomationPlayground = async (): Promise<void> => {
    const profileId = profiles.find((profile) => profile.active)?.id
    if (!profileId) {
      setError('请先选择一个活动 Profile')
      return
    }
    if (
      !window.confirm(
        '安装禁用状态的公开站点自动化验收模板？该模板无需账号，只访问 Selenium 与 Test Pages 的自动化测试页面。'
      )
    ) {
      return
    }
    setError(null)
    try {
      const result =
        await window.agenticBrowser.installAutomationPlayground(profileId)
      setStrategyWorkspace(result.strategyWorkspace)
      applyProjectWorkspace(result.projectWorkspace)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const deleteProject = async (projectId: string): Promise<void> => {
    if (!window.confirm(`确认删除 Project ${projectId}？`)) {
      return
    }
    try {
      applyProjectWorkspace(
        await window.agenticBrowser.deleteProject(projectId)
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const startProject = async (projectId: string): Promise<void> => {
    setError(null)
    try {
      applyProjectWorkspace(
        await window.agenticBrowser.startProjectRuntime(projectId)
      )
      await Promise.all([
        refreshProfiles(),
        refreshTabs(),
        refreshSnapshot(),
        refreshMonitor(),
        refreshCapabilityPolicy(),
        refreshStrategies()
      ])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const stopProject = async (projectId: string): Promise<void> => {
    setError(null)
    try {
      applyProjectWorkspace(
        await window.agenticBrowser.stopProjectRuntime(projectId)
      )
      await Promise.all([
        refreshSnapshot(),
        refreshMonitor(),
        refreshCapabilityPolicy(),
        refreshStrategies()
      ])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const pauseProject = async (projectId: string): Promise<void> => {
    setError(null)
    try {
      applyProjectWorkspace(
        await window.agenticBrowser.pauseProjectRuntime(projectId)
      )
      await Promise.all([
        refreshTabs(),
        refreshSnapshot(),
        refreshMonitor(),
        refreshStrategies()
      ])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const resumeProject = async (projectId: string): Promise<void> => {
    setError(null)
    try {
      applyProjectWorkspace(
        await window.agenticBrowser.resumeProjectRuntime(projectId)
      )
      await Promise.all([
        refreshTabs(),
        refreshSnapshot(),
        refreshMonitor(),
        refreshStrategies()
      ])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const newStrategy = (): void => {
    openStrategySettings(null)
  }

  const toggleStrategyEnabled = async (
    strategyId: string,
    enabled: boolean
  ): Promise<void> => {
    try {
      setStrategyWorkspace(
        await window.agenticBrowser.setStrategyEnabled(strategyId, enabled)
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const deleteStrategy = async (strategyId: string): Promise<void> => {
    if (!window.confirm(`确认删除 Strategy ${strategyId}？`)) {
      return
    }
    try {
      setStrategyWorkspace(
        await window.agenticBrowser.deleteStrategy(strategyId)
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const activeProject =
    projectWorkspace?.projects.find(
      (project) => project.id === projectWorkspace.activeProjectId
    ) ?? null
  const latestProjectRuntime =
    [...(projectWorkspace?.runtimes ?? [])]
      .reverse()
      .find(
        (runtime) =>
          runtime.projectId === (activeProject?.id ?? runtime.projectId)
      ) ?? null
  const activeProjectRuntime =
    [...(projectWorkspace?.runtimes ?? [])]
      .reverse()
      .find(isActiveProjectRuntime) ?? null
  const selectedActiveProjectRuntime =
    [...(projectWorkspace?.runtimes ?? [])]
      .reverse()
      .find(
        (runtime) =>
          runtime.projectId === activeProject?.id &&
          isActiveProjectRuntime(runtime)
      ) ?? null

  return (
    <main className="app-shell">
      {/*
        设置页以全屏覆盖层形式渲染，不卸载 toolbar / browser-placeholder，
        保证内嵌浏览器页面与运行时不中断（需求 1.5）。
      */}
      {view === 'settings' ? (
        <SettingsPage
          target={settingsTarget}
          projectWorkspace={projectWorkspace}
          strategyWorkspace={strategyWorkspace}
          profiles={profiles}
          anyRuntimeActive={activeProjectRuntime !== null}
          activeProfileId={
            profiles.find((profile) => profile.active)?.id ?? 'profile-default'
          }
          onClose={() => setView('workbench')}
          onSavedProjects={(workspace) => setProjectWorkspace(workspace)}
          onSavedStrategies={(workspace) => setStrategyWorkspace(workspace)}
          onReloadPage={() => void reload(false)}
        />
      ) : null}
      <aside
        className="sidebar"
        hidden={view === 'settings'}
        aria-hidden={view === 'settings'}
      >
        <header className="brand">
          <span className="brand-mark">AB</span>
          <div>
            <h1>{currentProfile.displayName}</h1>
            <p>Phase 3 · Project Runtime</p>
          </div>
        </header>

        <nav className="section-tabs" aria-label="工作台模块">
          <button
            className={`section-tab ${
              activeSection === 'projects' ? 'section-tab-active' : ''
            }`}
            type="button"
            onClick={() => setActiveSection('projects')}
          >
            项目
          </button>
          <button
            className={`section-tab ${
              activeSection === 'strategies' ? 'section-tab-active' : ''
            }`}
            type="button"
            onClick={() => setActiveSection('strategies')}
          >
            策略
          </button>
          <button
            className={`section-tab ${
              activeSection === 'filters' ? 'section-tab-active' : ''
            }`}
            type="button"
            onClick={() => setActiveSection('filters')}
          >
            过滤器
          </button>
        </nav>

        {activeSection === 'projects' ? (
          <ProjectPanel
            workspace={projectWorkspace}
            activeProject={activeProject}
            anyRuntimeActive={activeProjectRuntime !== null}
            selectedRuntime={selectedActiveProjectRuntime}
            onSelectProject={(id) => void selectProject(id)}
            onDeleteProject={(id) => void deleteProject(id)}
            onInstallPlayground={() => void installAutomationPlayground()}
            onNewProject={newProject}
            onOpenSettings={() =>
              openProjectSettings(activeProject?.id ?? null)
            }
            onStartProject={(id) => void startProject(id)}
            onPauseProject={(id) => void pauseProject(id)}
            onResumeProject={(id) => void resumeProject(id)}
            onStopProject={(id) => void stopProject(id)}
          />
        ) : null}

        {activeSection === 'strategies' ? (
          <StrategyPanel
            workspace={strategyWorkspace}
            activeProjectStrategies={activeProject?.strategies ?? []}
            strategyEntries={monitor?.strategies.entries ?? []}
            anyRuntimeActive={activeProjectRuntime !== null}
            onNewStrategy={newStrategy}
            onEditStrategy={(definition) =>
              openStrategySettings(definition.manifest.id)
            }
            onToggleEnabled={(id, enabled) =>
              void toggleStrategyEnabled(id, enabled)
            }
            onDeleteStrategy={(id) => void deleteStrategy(id)}
            onOpenSettings={() => openStrategySettings(null)}
          />
        ) : null}

        <section className="profile-panel">
          <div className="panel-heading">
            <h2>Profile</h2>
            <span>切换会重建 tabs</span>
          </div>
          <select
            aria-label="活动 Profile"
            value={profiles.find((profile) => profile.active)?.id ?? ''}
            disabled={activeProjectRuntime !== null}
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
                    disabled={activeProjectRuntime !== null}
                    onClick={() => void deleteProfile(profile.id)}
                  >
                    删除 {profile.name}
                  </button>
                ))}
            </div>
          ) : null}
          <label className="startup-setting">
            <span>
              登录时启动
              <small>
                {startup?.supported
                  ? startup.managedByWatchdog
                    ? '由 Watchdog 监督'
                    : '等待 Watchdog'
                  : '打包应用可用'}
              </small>
            </span>
            <input
              type="checkbox"
              checked={startup?.openAtLogin ?? false}
              disabled={!startup?.supported}
              onChange={() => void toggleOpenAtLogin()}
            />
          </label>
        </section>

        <section className="project-card">
          <div className="project-card-heading">
            <div>
              <span className="eyebrow">当前项目</span>
              <h2>{activeProject?.name ?? '未选择 Project'}</h2>
            </div>
            <span
              className={`status-dot ${
                snapshot?.health.status === 'healthy' &&
                latestProjectRuntime?.status !== 'failed'
                  ? ''
                  : 'status-dot-warning'
              }`}
              title={
                latestProjectRuntime?.status ??
                snapshot?.health.status ??
                '初始化'
              }
            />
          </div>

          <dl className="metric-grid">
            <div>
              <dt>项目状态</dt>
              <dd>{latestProjectRuntime?.status ?? '未运行'}</dd>
            </div>
            <div>
              <dt>Workflow</dt>
              <dd>{latestProjectRuntime?.currentNodeId ?? '—'}</dd>
            </div>
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
              <dt>运行项目</dt>
              <dd>{monitor?.activeProjectCount ?? '—'}</dd>
            </div>
            <div>
              <dt>人工接管</dt>
              <dd>{monitor?.pausedProjectCount ?? '—'}</dd>
            </div>
            <div>
              <dt>排队项目</dt>
              <dd>{monitor?.queuedProjectCount ?? '—'}</dd>
            </div>
            <div>
              <dt>活动下载</dt>
              <dd>{monitor?.downloads.active ?? '—'}</dd>
            </div>
            <div>
              <dt>扫描 / 下载</dt>
              <dd>
                {latestProjectRuntime
                  ? `${latestProjectRuntime.counters.scanned} / ${latestProjectRuntime.counters.downloaded}`
                  : '—'}
              </dd>
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

        <CapabilityPanel
          capabilityPolicy={capabilityPolicy}
          locked={activeProjectRuntime !== null}
          onToggleDefault={(key) => void toggleDefaultCapability(key)}
          onSetOrigin={(key, decision) =>
            void setOriginCapability(key, decision)
          }
        />

        <EventPanel events={events} />
      </aside>

      <header className="toolbar" hidden={view === 'settings'}>
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

      <section
        className={`browser-placeholder ${
          view === 'settings' ? 'browser-placeholder-hidden' : ''
        }`}
        aria-label="内嵌浏览器区域"
      >
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
