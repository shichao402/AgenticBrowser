import { type FormEvent, useCallback, useEffect, useState } from 'react'

import type {
  BrowserEvent,
  BrowserSnapshot,
  BrowserTab,
  CapabilityPolicySnapshot,
  CapabilitySettings,
  MonitorSnapshot,
  ProjectDraft,
  ProjectWorkspaceSnapshot,
  ProfileSummary,
  StrategyDefinition,
  StrategyManifest,
  StrategyWorkspaceSnapshot,
  StartupSettings
} from '../../shared/contracts'
import {
  createDefaultProjectDraft,
  createDefaultStrategyManifest,
  formatBytes,
  formatTime,
  isActiveProjectRuntime,
  toProjectDraft
} from './app-format'
import { CapabilityPanel, EventPanel } from './app-panels'

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
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null)
  const [projectDraftText, setProjectDraftText] = useState(
    JSON.stringify(createDefaultProjectDraft('profile-default'), null, 2)
  )
  const [activeSection, setActiveSection] = useState<
    'projects' | 'strategies' | 'filters'
  >('projects')
  const [editingStrategyId, setEditingStrategyId] = useState<string | null>(
    null
  )
  const [strategyManifestText, setStrategyManifestText] = useState(
    JSON.stringify(createDefaultStrategyManifest(), null, 2)
  )
  const [strategySource, setStrategySource] = useState(
    'agenticStrategy.log("strategy ready")'
  )
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
    const next = await window.agenticBrowser.getProjectWorkspace()
    setProjectWorkspace(next)
    const selected =
      next.projects.find((project) => project.id === next.activeProjectId) ??
      null
    if (selected) {
      setEditingProjectId(selected.id)
      setProjectDraftText(JSON.stringify(toProjectDraft(selected), null, 2))
    }
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

  const applyProjectWorkspace = (
    next: ProjectWorkspaceSnapshot,
    preferredProjectId?: string
  ): void => {
    setProjectWorkspace(next)
    const selected =
      next.projects.find(
        (project) => project.id === (preferredProjectId ?? next.activeProjectId)
      ) ?? null
    if (selected) {
      setEditingProjectId(selected.id)
      setProjectDraftText(JSON.stringify(toProjectDraft(selected), null, 2))
    } else {
      setEditingProjectId(null)
    }
  }

  const selectProject = async (projectId: string): Promise<void> => {
    try {
      const workspace = await window.agenticBrowser.setActiveProject(projectId)
      applyProjectWorkspace(workspace, projectId)
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

  const newProject = (): void => {
    const profileId =
      profiles.find((profile) => profile.active)?.id ?? 'profile-default'
    setEditingProjectId(null)
    setProjectDraftText(
      JSON.stringify(createDefaultProjectDraft(profileId), null, 2)
    )
    setActiveSection('projects')
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

  const saveProject = async (): Promise<void> => {
    setError(null)
    try {
      const draft = JSON.parse(projectDraftText) as ProjectDraft
      if (editingProjectId !== null && draft.id !== editingProjectId) {
        throw new Error('编辑现有 Project 时不能修改 ID；请使用“新建”')
      }
      applyProjectWorkspace(
        await window.agenticBrowser.saveProject(draft),
        draft.id
      )
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
        await window.agenticBrowser.startProjectRuntime(projectId),
        projectId
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
        await window.agenticBrowser.pauseProjectRuntime(projectId),
        projectId
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
        await window.agenticBrowser.resumeProjectRuntime(projectId),
        projectId
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

  const editStrategy = (definition: StrategyDefinition): void => {
    setEditingStrategyId(definition.manifest.id)
    setStrategyManifestText(JSON.stringify(definition.manifest, null, 2))
    setStrategySource(definition.source)
    setActiveSection('strategies')
  }

  const newStrategy = (): void => {
    setEditingStrategyId(null)
    setStrategyManifestText(
      JSON.stringify(createDefaultStrategyManifest(), null, 2)
    )
    setStrategySource('agenticStrategy.log("strategy ready")')
  }

  const saveStrategy = async (): Promise<void> => {
    setError(null)
    try {
      const manifest = JSON.parse(strategyManifestText) as StrategyManifest
      const existing = strategyWorkspace?.strategies.find(
        (definition) => definition.manifest.id === editingStrategyId
      )
      if (editingStrategyId !== null && manifest.id !== editingStrategyId) {
        throw new Error('编辑现有 Strategy 时不能修改 ID；请使用“新建”')
      }
      const workspace = await window.agenticBrowser.saveStrategy({
        manifest,
        source: strategySource,
        enabled: existing?.enabled ?? true
      })
      setStrategyWorkspace(workspace)
      setEditingStrategyId(manifest.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
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
      if (editingStrategyId === strategyId) {
        newStrategy()
      }
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
      <aside className="sidebar">
        <header className="brand">
          <span className="brand-mark">AB</span>
          <div>
            <h1>AgenticBrowser</h1>
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
          <section className="project-panel">
            <div className="panel-heading">
              <h2>Project</h2>
              <button
                type="button"
                disabled={activeProjectRuntime !== null}
                onClick={() => void installAutomationPlayground()}
              >
                安装自动化验收模板
              </button>
              <button type="button" onClick={newProject}>
                新建
              </button>
            </div>
            <p className="project-help">
              Project 固定 Profile、Strategy 版本、能力和 Workflow；
              运行时配置使用启动快照。
            </p>
            <div className="project-list">
              {projectWorkspace?.projects.length ? (
                projectWorkspace.projects.map((project) => {
                  const runtime = [...(projectWorkspace.runtimes ?? [])]
                    .reverse()
                    .find((candidate) => candidate.projectId === project.id)
                  return (
                    <article
                      className={`project-list-item ${
                        project.id === projectWorkspace.activeProjectId
                          ? 'project-list-item-active'
                          : ''
                      }`}
                      key={project.id}
                    >
                      <button
                        className="project-select"
                        type="button"
                        onClick={() => void selectProject(project.id)}
                      >
                        <strong>{project.name}</strong>
                        <small>
                          r{project.revision} · {runtime?.status ?? '未运行'}
                        </small>
                      </button>
                      <button
                        className="project-delete"
                        type="button"
                        disabled={activeProjectRuntime !== null}
                        onClick={() => void deleteProject(project.id)}
                      >
                        删除
                      </button>
                    </article>
                  )
                })
              ) : (
                <p className="event-empty">尚无 Project</p>
              )}
            </div>
            <div className="project-editor">
              <label>
                Project JSON
                <textarea
                  aria-label="Project JSON"
                  spellCheck={false}
                  value={projectDraftText}
                  onChange={(event) => setProjectDraftText(event.target.value)}
                />
              </label>
              <div className="project-actions">
                <button
                  type="button"
                  disabled={activeProjectRuntime !== null}
                  onClick={() => void saveProject()}
                >
                  保存
                </button>
                <button
                  type="button"
                  disabled={
                    !activeProject || selectedActiveProjectRuntime !== null
                  }
                  onClick={() =>
                    activeProject
                      ? void startProject(activeProject.id)
                      : undefined
                  }
                >
                  启动
                </button>
                <button
                  type="button"
                  disabled={
                    selectedActiveProjectRuntime === null ||
                    selectedActiveProjectRuntime.status === 'paused'
                  }
                  onClick={() =>
                    activeProject
                      ? void pauseProject(activeProject.id)
                      : undefined
                  }
                >
                  {selectedActiveProjectRuntime?.status === 'queued'
                    ? '暂停排队'
                    : '暂停并接管'}
                </button>
                <button
                  type="button"
                  disabled={selectedActiveProjectRuntime?.status !== 'paused'}
                  onClick={() =>
                    activeProject
                      ? void resumeProject(activeProject.id)
                      : undefined
                  }
                >
                  恢复自动化
                </button>
                <button
                  type="button"
                  disabled={selectedActiveProjectRuntime === null}
                  onClick={() =>
                    activeProject
                      ? void stopProject(activeProject.id)
                      : undefined
                  }
                >
                  停止
                </button>
              </div>
              {projectWorkspace?.strategyResolutions.length ? (
                <ul className="project-resolution-list">
                  {projectWorkspace.strategyResolutions.map((resolution) => (
                    <li key={resolution.strategyId}>
                      {resolution.strategyId}@{resolution.pinnedVersion}
                      {' · '}
                      {resolution.status}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </section>
        ) : null}

        {activeSection === 'strategies' ? (
          <section className="strategy-panel">
            <div className="panel-heading">
              <h2>Strategy</h2>
              <button
                type="button"
                disabled={activeProjectRuntime !== null}
                onClick={newStrategy}
              >
                新建
              </button>
            </div>
            <p className="strategy-help">
              启用控制注册表定义；运行时 allowlist 由 Project
              固定版本生成。项目运行期间定义不可修改。
            </p>
            <div className="strategy-list">
              {strategyWorkspace?.strategies.length ? (
                strategyWorkspace.strategies.map((definition) => {
                  const projectPin = activeProject?.strategies.find(
                    (pin) => pin.id === definition.manifest.id
                  )
                  const runtimeEntries =
                    monitor?.strategies.entries.filter(
                      (entry) => entry.strategyId === definition.manifest.id
                    ) ?? []
                  return (
                    <article
                      className="strategy-card"
                      key={definition.manifest.id}
                    >
                      <button
                        className="strategy-edit"
                        type="button"
                        onClick={() => editStrategy(definition)}
                      >
                        <strong>{definition.manifest.name}</strong>
                        <small>
                          {definition.manifest.id} ·{' '}
                          {definition.manifest.version}
                        </small>
                        <small>
                          {runtimeEntries.length === 0
                            ? '未运行'
                            : runtimeEntries
                                .map((entry) => entry.status)
                                .join(', ')}
                        </small>
                        {projectPin ? (
                          <small>当前 Project 固定 {projectPin.version}</small>
                        ) : null}
                      </button>
                      <label>
                        <input
                          type="checkbox"
                          checked={definition.enabled}
                          disabled={activeProjectRuntime !== null}
                          onChange={(event) =>
                            void toggleStrategyEnabled(
                              definition.manifest.id,
                              event.target.checked
                            )
                          }
                        />
                        启用
                      </label>
                      <button
                        className="strategy-delete"
                        type="button"
                        disabled={activeProjectRuntime !== null}
                        onClick={() =>
                          void deleteStrategy(definition.manifest.id)
                        }
                      >
                        删除
                      </button>
                    </article>
                  )
                })
              ) : (
                <p className="event-empty">尚无 Strategy</p>
              )}
            </div>
            <div className="strategy-editor">
              <label>
                Manifest JSON
                <textarea
                  aria-label="Strategy Manifest JSON"
                  spellCheck={false}
                  value={strategyManifestText}
                  onChange={(event) =>
                    setStrategyManifestText(event.target.value)
                  }
                />
              </label>
              <label>
                隔离 world 源码
                <textarea
                  aria-label="Strategy 源码"
                  spellCheck={false}
                  value={strategySource}
                  onChange={(event) => setStrategySource(event.target.value)}
                />
              </label>
              <button
                type="button"
                disabled={activeProjectRuntime !== null}
                onClick={() => void saveStrategy()}
              >
                保存并重载页面
              </button>
            </div>
          </section>
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
