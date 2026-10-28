import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BaseWindow, ipcMain, session, WebContentsView } from 'electron'

import {
  IPC_CHANNELS,
  type BrowserEvent,
  type CapabilityPolicy,
  type ContentFilterDefinition,
  type JsonValue,
  type MonitorSnapshot,
  type ProjectDraft,
  type ProjectRuntimeSnapshot,
  type ProjectWorkspaceSnapshot,
  type ReloadOptions,
  type WorkflowFailureCategory,
  type StrategyDefinition,
  type StrategyWorkspaceSnapshot,
  type StartupSettings
} from '../shared/contracts'
import {
  currentChannel,
  currentProfile,
  isDevChannel
} from '../shared/channel-runtime'
import {
  cloneProjectDefinition,
  cloneStrategyDefinitions,
  formatUnknownError,
  isPageViewVisible,
  isTerminalProjectRuntime,
  normalizeComparableUrl,
  parseDownloadIntentPayload,
  parseTakeoverReason,
  toProfileSummaries
} from './main-helpers'
import { BackgroundProjectRuntime } from './background-project-runtime'
import { BrowserTabManager } from './browser-tab-manager'
import { buildMonitorSnapshot } from './monitor-snapshot'
import type {
  BrowserDownloadAdapter,
  BrowserDownloadRequest
} from './browser-supervisor'
import { CapabilityStore, createCapabilityPolicy } from './capability-store'
import { type BrowserCheckpointStore } from './checkpoint-store'
import {
  AUTOMATION_PLAYGROUND_PROJECT_ID,
  AUTOMATION_PLAYGROUND_STRATEGY_ID,
  createAutomationPlaygroundProjectDraft,
  createAutomationPlaygroundStrategyDraft
} from './automation-playground-pilot'
import {
  ProjectDownloadManager,
  type ProjectDownloadReservation
} from './project-download-manager'
import {} from './project-download-fault-smoke'
import {} from './project-download-recovery-smoke'
import { ProjectItemStore } from './project-item-store'
import { ProjectScheduler } from './project-scheduler'
import {
  ProjectRuntimeStore,
  type ProjectRuntimeEnvelope
} from './project-runtime-store'
import {
  parseProjectDraft,
  ProjectStore,
  type ProjectState
} from './project-store'
import {
  requireRunnableProjectStrategies,
  resolveProjectStrategies
} from './project-strategy-resolver'
import { ProjectWorkflowEngine } from './project-workflow-engine'
import {
  startPhaseZeroProbeServer,
  type PhaseZeroProbeServer
} from './phase0-probe-server'
import {
  automatedTestRun,
  automationPlaygroundSmokeTest,
  projectConcurrencySmokeTest,
  projectDownloadFaultSmokeChild,
  projectDownloadRecoverySmokeChild,
  projectDownloadRendererRecoverySmokeChild,
  projectDownloadSmokeTest,
  projectTakeoverSmokeTest,
  recoverySmokeTest,
  smokeTest,
  strategyFaultSmokeTest,
  strategyWorkspaceSmokeTest,
  watchdogSmokeChild
} from './smoke-flags'
import {
  createProjectConcurrencySmokeDefinition,
  createProjectDownloadSmokeDefinition,
  createProjectTakeoverSmokeDefinition,
  createStrategyFaultSmokeDefinition,
  createStrategySmokeDefinitions
} from './smoke-fixtures'
import {
  cleanupAutomatedDownloads,
  createCheckpointStore,
  runAutomationPlaygroundSmoke,
  runProjectConcurrencySmoke,
  runProjectDownloadFaultSmokeChild,
  runProjectDownloadRecoverySmokeChild,
  runProjectDownloadRendererRecoverySmokeChild,
  runProjectDownloadSmoke,
  runProjectTakeoverSmoke,
  runRecoverySmoke,
  runStrategyFaultSmoke,
  runStrategyWorkspaceSmoke,
  runWatchdogSmokeChild,
  waitForStrategyRuntime,
  writeProjectDownloadFaultSmokeChildResult,
  writeProjectDownloadRendererSmokeChildResult
} from './smoke-runners'
import {
  closeSmokeRuntime,
  getMainProcessHeartbeat,
  initMainProcessHeartbeat,
  type MainWindowRuntime
} from './smoke-runtime'
import { writeSmokeResultFile } from './smoke-result-writer'
import { StructuredEventLog } from './structured-event-log'
import { DEFAULT_PROFILE_ID, ProfileStore } from './profile-store'
import {
  StrategyPolicyStore,
  type StrategyPolicyState
} from './strategy-policy-store'
import { StrategyStore, type StrategyState } from './strategy-store'
import type { StrategyDomainEvent } from './strategy-runtime'
import {
  launchPackagedWatchdog,
  WATCHDOG_AUTOSTART_ARGUMENT
} from './watchdog-launcher'

// 档位身份在构建期注入，这里只读结果。应用名必须在设置 userData
// 之前定好：Electron 用应用名推导默认数据目录，两档共用同一个名字
// 会让它们互相覆盖登录态与配置。
app.setName(currentProfile.displayName)

const managedUserDataPath = process.env.AGENTIC_USER_DATA_PATH
if (managedUserDataPath) {
  mkdirSync(managedUserDataPath, { recursive: true })
  app.setPath('userData', managedUserDataPath)
} else if (isDevChannel) {
  // 开发档必须落在自己的数据目录。app.setName 已经让它与正式档分开，
  // 这里再显式钉死一次，避免未来改动 setName 的时机把两档合回一处。
  const channelUserDataPath = join(
    app.getPath('appData'),
    currentProfile.userDataDirectoryName
  )
  mkdirSync(channelUserDataPath, { recursive: true })
  app.setPath('userData', channelUserDataPath)
}

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const SIDEBAR_WIDTH = 320
const TOOLBAR_HEIGHT = 104
const MIN_PAGE_SIZE = 240

let mainWindow: BaseWindow | null = null
let phaseZeroProbe: PhaseZeroProbeServer | null = null
let automatedDownloadDirectory: string | null = null
initMainProcessHeartbeat()
const runApplication = await prepareApplicationLaunch()

async function prepareApplicationLaunch(): Promise<boolean> {
  if (app.isPackaged && process.env.AGENTIC_WATCHDOG_MANAGED !== '1') {
    await launchPackagedWatchdog(
      {
        executablePath: process.execPath,
        resourcesPath: process.resourcesPath,
        userDataPath: app.getPath('userData')
      },
      process.argv
    )
    app.exit(0)
    return false
  }

  // 单实例锁按档位区分：两档必须能同时运行，共用一把锁会互相顶掉。
  if (!app.requestSingleInstanceLock({ channel: currentChannel })) {
    app.exit(0)
    return false
  }

  app.on('second-instance', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
  return true
}

/**
 * 冒烟场景的结果落盘目标。新增场景时在此登记一行即可。
 */
const smokeResultTargets = {
  smoke: { enabled: smokeTest, fileName: 'phase0-smoke-result.json' },
  recovery: {
    enabled: recoverySmokeTest,
    fileName: 'phase1-recovery-smoke-result.json'
  },
  strategyFault: {
    enabled: strategyFaultSmokeTest,
    fileName: 'phase2-strategy-fault-smoke-result.json'
  },
  strategyWorkspace: {
    enabled: strategyWorkspaceSmokeTest,
    fileName: 'phase2-strategy-workspace-smoke-result.json'
  },
  projectDownload: {
    enabled: projectDownloadSmokeTest,
    fileName: 'phase3-project-download-smoke-result.json'
  },
  projectConcurrency: {
    enabled: projectConcurrencySmokeTest,
    fileName: 'phase3-project-concurrency-smoke-result.json'
  },
  projectTakeover: {
    enabled: projectTakeoverSmokeTest,
    fileName: 'phase3-project-takeover-smoke-result.json'
  },
  automationPlayground: {
    enabled: automationPlaygroundSmokeTest,
    fileName: 'phase3-automation-playground-smoke-result.json'
  }
} as const

interface CreateMainWindowOptions {
  show?: boolean
  initialUrl?: string
  phaseZeroProbe?: boolean
  healthMonitoring?: boolean
  recoveryEnabled?: boolean
  profileId?: string
  checkpointStore?: BrowserCheckpointStore
  eventLog?: StructuredEventLog
  capabilityStore?: CapabilityStore
  capabilityPolicy?: CapabilityPolicy
  downloadRoot?: string
  profileStore?: ProfileStore
  projectStore?: ProjectStore
  projectRuntimeStore?: ProjectRuntimeStore
  strategyStore?: StrategyStore
  strategyPolicyStore?: StrategyPolicyStore
  strategyDefinitions?: StrategyDefinition[]
  allowedStrategyIds?: ReadonlySet<string>
}

function getStartupSettings(): StartupSettings {
  const supported =
    app.isPackaged &&
    (process.platform === 'win32' || process.platform === 'darwin')
  let openAtLogin = false
  if (supported) {
    openAtLogin =
      process.platform === 'win32'
        ? app.getLoginItemSettings({
            path: process.execPath,
            args: [WATCHDOG_AUTOSTART_ARGUMENT]
          }).openAtLogin
        : app.getLoginItemSettings().openAtLogin
  }

  return {
    supported,
    openAtLogin,
    managedByWatchdog: process.env.AGENTIC_WATCHDOG_MANAGED === '1'
  }
}

function setOpenAtLogin(enabled: boolean): StartupSettings {
  if (!getStartupSettings().supported) {
    throw new Error('开机启动仅支持 Windows/macOS 打包应用')
  }

  if (process.platform === 'win32') {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.execPath,
      args: [WATCHDOG_AUTOSTART_ARGUMENT]
    })
  } else {
    app.setLoginItemSettings({ openAtLogin: enabled })
  }
  return getStartupSettings()
}

async function createMainWindow(
  options: CreateMainWindowOptions = {}
): Promise<MainWindowRuntime> {
  const {
    show = true,
    initialUrl,
    phaseZeroProbe = false,
    healthMonitoring,
    recoveryEnabled,
    profileId,
    checkpointStore,
    eventLog,
    capabilityStore,
    capabilityPolicy,
    downloadRoot,
    profileStore,
    projectStore,
    projectRuntimeStore,
    strategyStore,
    strategyPolicyStore,
    strategyDefinitions,
    allowedStrategyIds
  } = options
  const window = new BaseWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: currentProfile.displayName,
    show: false
  })

  const shellView = new WebContentsView({
    webPreferences: {
      preload: join(currentDirectory, '../preload/shell.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  window.contentView.addChildView(shellView)
  const shellWebContents = shellView.webContents
  let shellEventsEnabled = true
  const events: BrowserEvent[] = []
  let eventCount = 0

  const publish = (event: BrowserEvent): void => {
    eventCount += 1
    const globalEvent = {
      ...event,
      sequence: eventCount
    }
    events.push(globalEvent)
    if (events.length > 500) {
      events.shift()
    }
    if (smokeTest && event.type.startsWith('strategy-')) {
      console.log(
        `AGENTIC_BROWSER_STRATEGY_SMOKE_EVENT ${JSON.stringify(globalEvent)}`
      )
    }
    if (
      (projectDownloadSmokeTest ||
        projectConcurrencySmokeTest ||
        projectTakeoverSmokeTest ||
        projectDownloadFaultSmokeChild ||
        projectDownloadRendererRecoverySmokeChild) &&
      (event.type.startsWith('strategy-') ||
        event.type.startsWith('download-') ||
        event.type.startsWith('project-runtime-'))
    ) {
      console.log(
        `AGENTIC_BROWSER_PROJECT_EVENT ${JSON.stringify(globalEvent)}`
      )
    }
    void eventLog?.append(globalEvent).catch((error: unknown) => {
      console.error('写入结构化事件日志失败', error)
    })
    if (shellEventsEnabled && !shellWebContents.isDestroyed()) {
      shellWebContents.send(IPC_CHANNELS.browserEvent, globalEvent)
    }
  }

  let activeProfileId = profileId ?? 'profile-default'
  let developmentCapabilityPolicy = capabilityPolicy
  let activeCapabilityPolicy = developmentCapabilityPolicy
  const developmentContentFilter: ContentFilterDefinition = {
    enabled: false,
    networkRules: [],
    cssRules: []
  }
  let activeContentFilter = structuredClone(developmentContentFilter)
  let registryStrategyDefinitions = cloneStrategyDefinitions(
    strategyDefinitions ?? []
  )
  let developmentAllowedStrategyIds = new Set(allowedStrategyIds ?? [])
  let activeStrategyDefinitions = cloneStrategyDefinitions(
    registryStrategyDefinitions
  )
  let activeAllowedStrategyIds = new Set(developmentAllowedStrategyIds)
  let activeWorkflowEngine: ProjectWorkflowEngine | null = null
  let activeDownloadManager: ProjectDownloadManager | null = null
  let activeItemStore: ProjectItemStore | null = null
  let activeDownloadAdapter: BrowserDownloadAdapter | undefined
  let pendingManagedDownloads: Array<
    Extract<ProjectDownloadReservation, { kind: 'reserved' }>
  > = []
  let currentProjectRuntime: ProjectRuntimeSnapshot | null = null
  let projectScheduler: ProjectScheduler | null = null
  const backgroundProjectRuntimes = new Map<string, BackgroundProjectRuntime>()
  let handleStrategyDomainEvent:
    | ((event: {
        strategyId: string
        name: string
        payload?: JsonValue
        url: string
      }) => JsonValue | void | Promise<JsonValue | void>)
    | null = null
  let requestManualTakeover:
    | ((
        projectId: string,
        reason: string,
        category: WorkflowFailureCategory
      ) => void)
    | null = null
  let workflowTickTimer: NodeJS.Timeout | null = null
  let workflowTickInFlight = false
  const finalizedProjectRuntimeIds = new Set<string>()
  const activeQuarantinedStrategyIds = new Set<string>()
  /**
   * 全屏覆盖层（设置页）是否压住了页面视图。
   * 原生 WebContentsView 的层位高于壳层渲染层，React 的 z-index 无法覆盖它，
   * 因此覆盖层打开时必须由主进程关闭页面视图的可见性。
   */
  let pageOverlayVisible = false
  const createSupervisor = (
    nextProfileId: string,
    nextInitialUrl?: string
  ): BrowserTabManager =>
    new BrowserTabManager(
      window,
      (event) => {
        if (
          currentProjectRuntime &&
          !isTerminalProjectRuntime(currentProjectRuntime)
        ) {
          publish({
            ...event,
            projectId: currentProjectRuntime.projectId,
            runtimeId: currentProjectRuntime.runtimeId
          })
          return
        }
        publish(event)
      },
      {
        ...(nextInitialUrl ? { initialUrl: nextInitialUrl } : {}),
        strategyPreloadPath: join(
          currentDirectory,
          '../preload/strategy-bootstrap.cjs'
        ),
        phaseZeroProbe,
        healthMonitoring: healthMonitoring ?? !phaseZeroProbe,
        recoveryEnabled: recoveryEnabled ?? !phaseZeroProbe,
        ...(activeCapabilityPolicy
          ? { capabilityPolicy: activeCapabilityPolicy }
          : {}),
        contentFilter: activeContentFilter,
        ...(activeDownloadAdapter
          ? { downloadAdapter: activeDownloadAdapter }
          : {}),
        ...(downloadRoot
          ? { downloadDirectory: join(downloadRoot, nextProfileId) }
          : {}),
        profileId: nextProfileId,
        ...(checkpointStore ? { checkpointStore } : {}),
        strategyDefinitions: activeStrategyDefinitions,
        allowedStrategyIds: activeAllowedStrategyIds,
        quarantinedStrategyIds: activeQuarantinedStrategyIds,
        visible: !pageOverlayVisible,
        onStrategyDomainEvent: (event) => handleStrategyDomainEvent?.(event)
      }
    )
  let supervisor = createSupervisor(activeProfileId, initialUrl)
  let visibleBackgroundRuntimeId: string | null = null

  const getVisibleSupervisor = (): BrowserTabManager => {
    if (visibleBackgroundRuntimeId) {
      const runtime = backgroundProjectRuntimes.get(visibleBackgroundRuntimeId)
      if (runtime) {
        return runtime.supervisor
      }
      visibleBackgroundRuntimeId = null
    }
    return supervisor
  }
  /** 覆盖层打开时，任何视图都不得显示。 */
  const applyPageViewVisibility = (): void => {
    supervisor.setVisible(
      isPageViewVisible(pageOverlayVisible, !visibleBackgroundRuntimeId)
    )
    for (const [runtimeId, runtime] of backgroundProjectRuntimes) {
      runtime.setVisible(
        isPageViewVisible(
          pageOverlayVisible,
          runtimeId === visibleBackgroundRuntimeId
        )
      )
    }
  }
  const showProjectSupervisor = (projectId: string | null): void => {
    const background = projectId
      ? [...backgroundProjectRuntimes.entries()].find(
          ([, runtime]) => runtime.getRuntime().projectId === projectId
        )
      : undefined
    visibleBackgroundRuntimeId = background ? background[0] : null
    applyPageViewVisibility()
  }

  const browserBounds = () => {
    const { width, height } = window.getContentBounds()
    return {
      x: SIDEBAR_WIDTH,
      y: TOOLBAR_HEIGHT,
      width: Math.max(MIN_PAGE_SIZE, width - SIDEBAR_WIDTH),
      height: Math.max(MIN_PAGE_SIZE, height - TOOLBAR_HEIGHT)
    }
  }
  const layout = (): void => {
    const { width, height } = window.getContentBounds()
    shellView.setBounds({ x: 0, y: 0, width, height })
    const bounds = browserBounds()
    supervisor.setBounds(bounds)
    for (const runtime of backgroundProjectRuntimes.values()) {
      runtime.setBounds(bounds)
    }
  }

  const assertTrustedSender = (senderId: number): void => {
    if (senderId !== shellView.webContents.id) {
      throw new Error('拒绝来自非 BrowserShell 的 IPC 调用')
    }
  }

  let supervisorOperationQueue: Promise<void> = Promise.resolve()
  const enqueueSupervisorOperation = <T>(
    operation: () => T | Promise<T>
  ): Promise<T> => {
    const pending = supervisorOperationQueue.then(operation)
    supervisorOperationQueue = pending.then(
      () => undefined,
      () => undefined
    )
    return pending
  }
  const readSupervisor = <T>(
    read: (current: BrowserTabManager) => T
  ): Promise<T> =>
    enqueueSupervisorOperation(() => read(getVisibleSupervisor()))
  const getStrategyWorkspaceSnapshot = (): StrategyWorkspaceSnapshot => ({
    strategies: cloneStrategyDefinitions(registryStrategyDefinitions),
    developmentAllowedStrategyIds: [...developmentAllowedStrategyIds].sort()
  })
  const applyDevelopmentStrategyConfiguration = async (
    state: StrategyState,
    policy: StrategyPolicyState
  ): Promise<StrategyWorkspaceSnapshot> => {
    const existingIds = new Set(
      state.strategies.map((definition) => definition.manifest.id)
    )
    registryStrategyDefinitions = cloneStrategyDefinitions(state.strategies)
    developmentAllowedStrategyIds = new Set(
      policy.developmentAllowedStrategyIds.filter((id) => existingIds.has(id))
    )
    activeStrategyDefinitions = cloneStrategyDefinitions(
      registryStrategyDefinitions
    )
    activeAllowedStrategyIds = new Set(developmentAllowedStrategyIds)
    await supervisor.setStrategyConfiguration(
      activeStrategyDefinitions,
      activeAllowedStrategyIds
    )
    return getStrategyWorkspaceSnapshot()
  }
  const buildProjectWorkspaceSnapshot = async (
    state: ProjectState
  ): Promise<ProjectWorkspaceSnapshot> => {
    const activeProject =
      state.projects.find((project) => project.id === state.activeProjectId) ??
      null
    const runtimes = projectRuntimeStore
      ? (await projectRuntimeStore.read()).runtimes.map(({ runtime }) =>
          structuredClone(runtime)
        )
      : []
    return {
      projects: state.projects.map(cloneProjectDefinition),
      activeProjectId: state.activeProjectId,
      runtimes,
      strategyResolutions: activeProject
        ? resolveProjectStrategies(activeProject, registryStrategyDefinitions)
            .resolutions
        : []
    }
  }
  const readProjectWorkspace = async (): Promise<ProjectWorkspaceSnapshot> => {
    if (!projectStore) {
      throw new Error('Project Store 当前不可用')
    }
    return buildProjectWorkspaceSnapshot(await projectStore.read())
  }
  const assertProjectRuntimeInactive = async (
    operation: string
  ): Promise<void> => {
    const state = await projectRuntimeStore?.read()
    if (
      state?.runtimes.some(({ runtime }) => !isTerminalProjectRuntime(runtime))
    ) {
      throw new Error(`Project Runtime 运行期间不能${operation}；请先停止项目`)
    }
  }
  const publishProjectRuntimeEvent = (
    type:
      | 'project-runtime-started'
      | 'project-runtime-paused'
      | 'project-runtime-resumed'
      | 'project-runtime-stopped'
      | 'project-runtime-failed',
    detail: string
  ): void => {
    publish({
      sequence: 0,
      type,
      timestamp: new Date().toISOString(),
      url: supervisor.getSnapshot().url,
      detail,
      ...(currentProjectRuntime
        ? {
            projectId: currentProjectRuntime.projectId,
            runtimeId: currentProjectRuntime.runtimeId
          }
        : {})
    })
  }
  const createProjectDownloadAdapter = (
    manager: ProjectDownloadManager
  ): BrowserDownloadAdapter => {
    let completionQueue = Promise.resolve()
    const adapter: BrowserDownloadAdapter = {
      reserve: async (request: BrowserDownloadRequest) => {
        const requestUrls = new Set(
          [request.sourceUrl, ...request.urlChain].map(normalizeComparableUrl)
        )
        const index = pendingManagedDownloads.findIndex((reservation) => {
          const record = reservation.record
          return (
            requestUrls.has(normalizeComparableUrl(record.sourceUrl)) ||
            (record.originalFileName === request.originalFileName &&
              normalizeComparableUrl(record.sourcePage) ===
                normalizeComparableUrl(request.sourcePage))
          )
        })
        if (index < 0) {
          throw new Error(
            `下载没有已授权的 Strategy 意图：${request.sourceUrl}`
          )
        }
        const [reservation] = pendingManagedDownloads.splice(index, 1)
        if (!reservation) {
          throw new Error('下载意图队列状态无效')
        }
        return {
          kind: 'reserved',
          downloadId: reservation.record.downloadId,
          temporaryPath: reservation.record.temporaryPath,
          displayName: reservation.record.safeFileName
        }
      },
      markDownloading: async (downloadId) => {
        await manager.markDownloading(downloadId)
      },
      complete: (downloadId) => {
        const pending = completionQueue.then(async () => {
          const record = await manager.complete(downloadId)
          const outstanding = (await manager.read()).records.some(
            (candidate) =>
              candidate.runtimeId === record.runtimeId &&
              (candidate.status === 'reserved' ||
                candidate.status === 'downloading')
          )
          if (!outstanding) {
            const completionEvent: StrategyDomainEvent = {
              strategyId: 'host-download-manager',
              name: 'download.completed',
              payload: {
                downloadId: record.downloadId,
                businessItemId: record.businessItemId,
                attachmentId: record.attachmentId,
                finalPath: record.finalPath,
                sha256: record.sha256,
                size: record.size
              },
              url: record.sourcePage
            }
            setImmediate(() => {
              void Promise.resolve(
                handleStrategyDomainEvent?.(completionEvent)
              ).catch((error: unknown) => {
                console.error('投递下载完成事件失败', error)
              })
            })
          }
          return { finalPath: record.finalPath, size: record.size }
        })
        completionQueue = pending.then(
          () => undefined,
          () => undefined
        )
        return pending
      },
      fail: async (downloadId, category, detail) => {
        const record = await manager.fail(downloadId, category, detail)
        await handleStrategyDomainEvent?.({
          strategyId: 'host-download-manager',
          name: 'download.failed',
          payload: {
            downloadId: record.downloadId,
            businessItemId: record.businessItemId,
            attachmentId: record.attachmentId,
            category,
            detail
          },
          url: record.sourcePage
        })
      }
    }
    return adapter
  }
  const startProjectRuntime = async (
    runtimeId: string
  ): Promise<ProjectWorkspaceSnapshot> => {
    if (!projectStore || !profileStore || !projectRuntimeStore) {
      throw new Error('Project Runtime 依赖当前不可用')
    }
    const [projectState, profileState, runtimeState] = await Promise.all([
      projectStore.read(),
      profileStore.read(),
      projectRuntimeStore.read()
    ])
    const queued = runtimeState.runtimes.find(
      ({ runtime }) => runtime.runtimeId === runtimeId
    )
    if (!queued || queued.runtime.status !== 'queued') {
      throw new Error(`排队中的 Project Runtime 不存在：${runtimeId}`)
    }
    const project = projectState.projects.find(
      (candidate) => candidate.id === queued.runtime.projectId
    )
    if (!project) {
      throw new Error(`Project 不存在：${queued.runtime.projectId}`)
    }
    if (!project.enabled) {
      throw new Error(`Project 已禁用：${project.name}`)
    }
    const runtimeProject = queued.projectSnapshot
    const startupUrl = runtimeProject.startupPages[0]
    if (!startupUrl) {
      throw new Error('Project 至少需要一个初始化页面')
    }
    if (
      !profileState.profiles.some(
        (profile) => profile.id === runtimeProject.profileId
      )
    ) {
      throw new Error(
        `Project 绑定的 Profile 不存在：${runtimeProject.profileId}`
      )
    }

    const resolved = resolveProjectStrategies(
      runtimeProject,
      registryStrategyDefinitions
    )
    requireRunnableProjectStrategies(resolved)
    const selectedState = projectState
    const previousProfileId = activeProfileId
    const previousUrl = supervisor.getSnapshot().url
    const previousDefinitions = cloneStrategyDefinitions(
      activeStrategyDefinitions
    )
    const previousAllowed = new Set(activeAllowedStrategyIds)
    const previousCapabilityPolicy = activeCapabilityPolicy
    const previousContentFilter = activeContentFilter
    const previousDownloadManager = activeDownloadManager
    const previousItemStore = activeItemStore
    const previousDownloadAdapter = activeDownloadAdapter
    const previousPendingDownloads = pendingManagedDownloads

    activeStrategyDefinitions = cloneStrategyDefinitions(resolved.definitions)
    activeAllowedStrategyIds = new Set(resolved.allowedStrategyIds)
    activeCapabilityPolicy = structuredClone(runtimeProject.capabilities)
    activeContentFilter = structuredClone(runtimeProject.filter)
    let startingRuntimeId: string | null = null

    try {
      const envelope = queued
      startingRuntimeId = envelope.runtime.runtimeId
      currentProjectRuntime = structuredClone(envelope.runtime)
      activeDownloadManager = new ProjectDownloadManager(
        join(runtimeProject.output.root, 'records', 'downloads.json'),
        { runtimeStore: projectRuntimeStore }
      )
      activeItemStore = new ProjectItemStore(
        join(runtimeProject.output.root, 'records', 'items.json')
      )
      await activeDownloadManager.recoverInterrupted()
      pendingManagedDownloads = []
      activeDownloadAdapter = createProjectDownloadAdapter(
        activeDownloadManager
      )

      if (runtimeProject.profileId === activeProfileId) {
        await supervisor.setStrategyConfiguration([], new Set())
        supervisor.setCapabilityPolicy(activeCapabilityPolicy)
        supervisor.setContentFilter(activeContentFilter)
        supervisor.setDownloadAdapter(activeDownloadAdapter)
        await supervisor.navigate(startupUrl)
        await supervisor.setStrategyConfiguration(
          activeStrategyDefinitions,
          activeAllowedStrategyIds
        )
      } else {
        supervisor.dispose()
        activeProfileId = runtimeProject.profileId
        supervisor = createSupervisor(runtimeProject.profileId, startupUrl)
        await supervisor.start()
        layout()
        applyPageViewVisibility()
        await profileStore.setActive(runtimeProject.profileId)
      }

      const engine = new ProjectWorkflowEngine(
        envelope.runtime.runtimeId,
        projectRuntimeStore,
        {
          navigate: async (url, signal) => {
            if (signal.aborted) {
              throw new Error('Workflow 导航已取消')
            }
            await supervisor.navigate(url)
          },
          onRuntimeChanged: (runtime) => {
            currentProjectRuntime = structuredClone(runtime)
          }
        }
      )
      activeWorkflowEngine = engine
      currentProjectRuntime = structuredClone(envelope.runtime)
      publishProjectRuntimeEvent(
        'project-runtime-started',
        `${runtimeProject.name}; runtimeId=${envelope.runtime.runtimeId}`
      )
      const runtime = await engine.start()
      currentProjectRuntime = structuredClone(runtime)
      if (isTerminalProjectRuntime(runtime)) {
        await finalizeProjectRuntime(runtime, runtimeProject.name)
      } else {
        startWorkflowTicker(engine)
      }
      return buildProjectWorkspaceSnapshot(selectedState)
    } catch (error) {
      const reason = formatUnknownError(error)
      let rollbackFailure: string | null = null
      if (
        activeWorkflowEngine &&
        !isTerminalProjectRuntime(currentProjectRuntime)
      ) {
        currentProjectRuntime = await activeWorkflowEngine
          .fail('unknown', reason)
          .catch(() => currentProjectRuntime)
      } else if (startingRuntimeId) {
        const starting = (await projectRuntimeStore.read()).runtimes.find(
          ({ runtime }) => runtime.runtimeId === startingRuntimeId
        )
        if (starting && !isTerminalProjectRuntime(starting.runtime)) {
          const status =
            starting.runtime.status === 'queued' ? 'cancelled' : 'failed'
          currentProjectRuntime = (
            await projectRuntimeStore.transition(startingRuntimeId, status, {
              lastError: reason,
              lastFailureCategory: 'unknown'
            })
          ).runtime
        }
      }
      activeWorkflowEngine = null
      activeStrategyDefinitions = previousDefinitions
      activeAllowedStrategyIds = previousAllowed
      activeCapabilityPolicy = previousCapabilityPolicy
      activeContentFilter = previousContentFilter
      activeDownloadManager = previousDownloadManager
      activeItemStore = previousItemStore
      activeDownloadAdapter = previousDownloadAdapter
      pendingManagedDownloads = previousPendingDownloads
      try {
        if (activeProfileId !== previousProfileId) {
          supervisor.dispose()
          activeProfileId = previousProfileId
          supervisor = createSupervisor(previousProfileId, previousUrl)
          await supervisor.start()
          layout()
          applyPageViewVisibility()
          await profileStore.setActive(previousProfileId)
        } else {
          if (activeCapabilityPolicy) {
            supervisor.setCapabilityPolicy(activeCapabilityPolicy)
          }
          supervisor.setContentFilter(activeContentFilter)
          supervisor.setDownloadAdapter(activeDownloadAdapter)
          await supervisor.setStrategyConfiguration(
            activeStrategyDefinitions,
            activeAllowedStrategyIds
          )
          if (supervisor.getSnapshot().url !== previousUrl) {
            await supervisor.navigate(previousUrl)
          }
        }
      } catch (rollbackError) {
        rollbackFailure = formatUnknownError(rollbackError)
      }
      const detail = rollbackFailure
        ? `${reason}；回滚失败：${rollbackFailure}`
        : reason
      publishProjectRuntimeEvent(
        'project-runtime-failed',
        `${runtimeProject.name}; ${detail}`
      )
      throw new Error(`Project Runtime 启动失败：${detail}`)
    }
  }
  const restoreDevelopmentProjectContext = async (): Promise<void> => {
    activeStrategyDefinitions = cloneStrategyDefinitions(
      registryStrategyDefinitions
    )
    activeAllowedStrategyIds = new Set(developmentAllowedStrategyIds)
    activeCapabilityPolicy = developmentCapabilityPolicy
    activeContentFilter = developmentContentFilter
    activeDownloadManager = null
    activeItemStore = null
    activeDownloadAdapter = undefined
    pendingManagedDownloads = []
    if (activeCapabilityPolicy) {
      supervisor.setCapabilityPolicy(activeCapabilityPolicy)
    }
    supervisor.setContentFilter(activeContentFilter)
    supervisor.setDownloadAdapter(undefined)
    await supervisor.setStrategyPaused(false)
    await supervisor.setStrategyConfiguration(
      activeStrategyDefinitions,
      activeAllowedStrategyIds
    )
  }
  const stopWorkflowTicker = (): void => {
    if (workflowTickTimer) {
      clearInterval(workflowTickTimer)
      workflowTickTimer = null
    }
    workflowTickInFlight = false
  }
  const finalizeProjectRuntime = async (
    runtime: ProjectRuntimeSnapshot,
    projectName?: string
  ): Promise<void> => {
    currentProjectRuntime = structuredClone(runtime)
    if (!isTerminalProjectRuntime(runtime)) {
      return
    }
    if (finalizedProjectRuntimeIds.has(runtime.runtimeId)) {
      return
    }
    stopWorkflowTicker()
    activeWorkflowEngine = null
    await restoreDevelopmentProjectContext()
    finalizedProjectRuntimeIds.add(runtime.runtimeId)
    const resolvedProjectName =
      projectName ??
      (await projectStore?.read())?.projects.find(
        (project) => project.id === runtime.projectId
      )?.name ??
      runtime.projectId
    publishProjectRuntimeEvent(
      runtime.status === 'failed'
        ? 'project-runtime-failed'
        : 'project-runtime-stopped',
      `${resolvedProjectName}; status=${runtime.status}; runtimeId=${runtime.runtimeId}`
    )
    projectScheduler?.notifyRuntimeTerminal(runtime)
  }
  const handleWorkflowFailure = async (
    engine: ProjectWorkflowEngine,
    error: unknown
  ): Promise<void> => {
    const reason = formatUnknownError(error)
    const runtime = await engine
      .fail('unknown', reason)
      .catch(() => currentProjectRuntime)
    if (runtime) {
      await finalizeProjectRuntime(runtime)
    }
  }
  const startWorkflowTicker = (engine: ProjectWorkflowEngine): void => {
    stopWorkflowTicker()
    workflowTickTimer = setInterval(() => {
      if (workflowTickInFlight || activeWorkflowEngine !== engine) {
        return
      }
      workflowTickInFlight = true
      void enqueueSupervisorOperation(async () => {
        if (activeWorkflowEngine !== engine) {
          return
        }
        const runtime = await engine.tick()
        currentProjectRuntime = structuredClone(runtime)
        if (isTerminalProjectRuntime(runtime)) {
          await finalizeProjectRuntime(runtime)
        }
      })
        .catch((error: unknown) => handleWorkflowFailure(engine, error))
        .finally(() => {
          workflowTickInFlight = false
        })
    }, 1_000)
    workflowTickTimer.unref()
  }
  handleStrategyDomainEvent = async (event) => {
    if (
      event.name === 'project.authentication-required' ||
      event.name === 'project.page-changed'
    ) {
      if (!currentProjectRuntime || !requestManualTakeover) {
        throw new Error('当前 Project Runtime 不支持人工接管请求')
      }
      const authentication = event.name === 'project.authentication-required'
      requestManualTakeover(
        currentProjectRuntime.projectId,
        parseTakeoverReason(
          event.payload,
          authentication
            ? '页面要求重新登录，等待人工接管'
            : '页面结构变化，等待人工接管'
        ),
        authentication ? 'authentication' : 'page-changed'
      )
      return { kind: 'pause-requested' }
    }
    if (event.name === 'project.item-observed') {
      if (!activeItemStore || !projectRuntimeStore || !currentProjectRuntime) {
        throw new Error('当前没有可接收帖子观测的 Project Runtime')
      }
      const result = await activeItemStore.observe(
        currentProjectRuntime.projectId,
        event.payload,
        event.url,
        currentProjectRuntime.runtimeId
      )
      if (result.firstSeenInRuntime) {
        const counters =
          result.record.classification === 'matched'
            ? { scanned: 1, matched: 1 }
            : { scanned: 1, skipped: 1 }
        currentProjectRuntime = (
          await projectRuntimeStore.incrementCounters(
            currentProjectRuntime.runtimeId,
            counters
          )
        ).runtime
      }
      return {
        kind: result.kind,
        firstSeenInRuntime: result.firstSeenInRuntime,
        businessItemId: result.record.businessItemId
      }
    }
    if (event.name === 'download.intent') {
      if (
        !activeDownloadManager ||
        !projectRuntimeStore ||
        !currentProjectRuntime
      ) {
        throw new Error('当前没有可接收下载意图的 Project Runtime')
      }
      const intent = parseDownloadIntentPayload(event.payload)
      if (!intent) {
        throw new Error('download.intent payload 格式无效')
      }
      const runtimeState = await projectRuntimeStore.read()
      const envelope = runtimeState.runtimes.find(
        ({ runtime }) => runtime.runtimeId === currentProjectRuntime?.runtimeId
      )
      if (!envelope) {
        throw new Error('下载意图对应的 Project Runtime 不存在')
      }
      const reservation = await activeDownloadManager.reserve(
        envelope.projectSnapshot,
        {
          runtimeId: envelope.runtime.runtimeId,
          workflowNodeId: envelope.runtime.currentNodeId,
          sourcePage: event.url,
          sourceUrl: intent.sourceUrl,
          businessItemId: intent.businessItemId,
          attachmentId: intent.attachmentId,
          originalFileName: intent.originalFileName,
          ...(intent.mime ? { mime: intent.mime } : {}),
          ...(intent.expectedBytes === null
            ? {}
            : { expectedBytes: intent.expectedBytes })
        }
      )
      if (reservation.kind === 'reserved') {
        if (pendingManagedDownloads.length >= 100) {
          await activeDownloadManager.fail(
            reservation.record.downloadId,
            'unknown',
            '待下载意图队列超过 100'
          )
          throw new Error('待下载意图队列已满')
        }
        pendingManagedDownloads.push(reservation)
        return {
          kind: 'reserved',
          downloadId: reservation.record.downloadId,
          safeFileName: reservation.record.safeFileName
        }
      }
      if (reservation.kind === 'rejected') {
        const detail = reservation.record.error ?? '下载预检被宿主拒绝'
        const failureEvent = {
          strategyId: 'host-download-manager',
          name: 'download.failed',
          payload: {
            downloadId: reservation.record.downloadId,
            businessItemId: reservation.record.businessItemId,
            attachmentId: reservation.record.attachmentId,
            category: 'disk',
            detail
          },
          url: reservation.record.sourcePage
        } satisfies StrategyDomainEvent
        if (reservation.newlyCreated) {
          publish({
            sequence: 0,
            type: 'download-failed',
            timestamp: new Date().toISOString(),
            url: reservation.record.sourcePage,
            detail: `${reservation.record.safeFileName}; ${detail}`,
            projectId: reservation.record.projectId,
            runtimeId: reservation.record.runtimeId
          })
          setImmediate(() => {
            void Promise.resolve(
              handleStrategyDomainEvent?.(failureEvent)
            ).catch((error: unknown) => {
              console.error('投递下载预检失败事件失败', error)
            })
          })
        }
        return {
          kind: 'rejected',
          downloadId: reservation.record.downloadId,
          category: 'disk',
          detail,
          newlyCreated: reservation.newlyCreated
        }
      }
      if (reservation.kind === 'in-progress') {
        return {
          kind: 'in-progress',
          downloadId: reservation.record.downloadId,
          canStart: pendingManagedDownloads.some(
            ({ record }) => record.downloadId === reservation.record.downloadId
          )
        }
      }
      return {
        kind: 'duplicate',
        downloadId: reservation.record.downloadId,
        finalPath: reservation.record.finalPath,
        sha256: reservation.record.sha256,
        size: reservation.record.size
      }
    }

    const engine = activeWorkflowEngine
    if (!engine) {
      return null
    }
    await enqueueSupervisorOperation(async () => {
      if (activeWorkflowEngine !== engine) {
        return
      }
      const runtime = await engine.handleEvent({
        name: event.name,
        ...(event.payload === undefined
          ? {}
          : { payload: structuredClone(event.payload) })
      })
      currentProjectRuntime = structuredClone(runtime)
      if (isTerminalProjectRuntime(runtime)) {
        await finalizeProjectRuntime(runtime)
      }
    }).catch(async (error: unknown) => {
      await handleWorkflowFailure(engine, error)
      throw error
    })
    return null
  }
  const timeoutProjectRuntime = async (
    runtimeId: string,
    reason: string
  ): Promise<void> => {
    if (!projectRuntimeStore) {
      throw new Error('Project Runtime Store 当前不可用')
    }
    const state = await projectRuntimeStore.read()
    const envelope = state.runtimes.find(
      ({ runtime }) => runtime.runtimeId === runtimeId
    )
    if (!envelope || isTerminalProjectRuntime(envelope.runtime)) {
      return
    }
    const runtime =
      activeWorkflowEngine?.runtimeId === runtimeId
        ? await activeWorkflowEngine.fail('timeout', reason)
        : (
            await projectRuntimeStore.transition(runtimeId, 'failed', {
              lastError: reason,
              lastFailureCategory: 'timeout',
              counters: { failed: 1 }
            })
          ).runtime
    await finalizeProjectRuntime(runtime, envelope.projectSnapshot.name)
  }
  const pauseProjectRuntime = async (
    projectId: string,
    reason: string | null = null,
    category: WorkflowFailureCategory | null = null
  ): Promise<ProjectWorkspaceSnapshot> => {
    if (!projectStore || !projectRuntimeStore) {
      throw new Error('Project Runtime 依赖当前不可用')
    }
    const state = await projectRuntimeStore.read()
    const envelope = [...state.runtimes]
      .reverse()
      .find(
        ({ runtime }) =>
          runtime.projectId === projectId && !isTerminalProjectRuntime(runtime)
      )
    if (!envelope) {
      throw new Error('没有可暂停的 Project Runtime')
    }
    if (envelope.runtime.status === 'paused') {
      showProjectSupervisor(projectId)
      return readProjectWorkspace()
    }
    const { runtimeId } = envelope.runtime
    const projectName =
      (await projectStore.read()).projects.find(
        (project) => project.id === projectId
      )?.name ?? envelope.projectSnapshot.name
    projectScheduler?.suspend(projectId)

    if (envelope.runtime.status === 'queued') {
      const paused = (
        await projectRuntimeStore.transition(runtimeId, 'paused', {
          nextWakeAt: null,
          lastError: reason ?? '等待人工恢复',
          lastFailureCategory: category
        })
      ).runtime
      publish({
        sequence: 0,
        type: 'project-runtime-paused',
        timestamp: new Date().toISOString(),
        url: envelope.projectSnapshot.startupPages[0]!,
        detail: `${projectName}; runtimeId=${runtimeId}; queued=true`,
        projectId: paused.projectId,
        runtimeId
      })
      return readProjectWorkspace()
    }

    projectScheduler?.holdPausedRuntime(runtimeId)
    try {
      const background = backgroundProjectRuntimes.get(runtimeId)
      if (background) {
        const paused = await background.pause(reason, category)
        if (isTerminalProjectRuntime(paused)) {
          projectScheduler?.releasePausedRuntime(runtimeId)
          await finalizeBackgroundProjectRuntime(paused, projectName)
          return readProjectWorkspace()
        }
        showProjectSupervisor(projectId)
        publish({
          sequence: 0,
          type: 'project-runtime-paused',
          timestamp: new Date().toISOString(),
          url: background.supervisor.getSnapshot().url,
          detail:
            `${projectName}; runtimeId=${runtimeId}; ` +
            `manual-takeover=true${reason ? `; reason=${reason}` : ''}`,
          projectId,
          runtimeId
        })
        return readProjectWorkspace()
      }

      if (activeWorkflowEngine?.runtimeId !== runtimeId) {
        throw new Error('Project Runtime 的浏览器执行上下文不可用')
      }
      const paused = await activeWorkflowEngine.pause(reason, category)
      currentProjectRuntime = structuredClone(paused)
      if (isTerminalProjectRuntime(paused)) {
        projectScheduler?.releasePausedRuntime(runtimeId)
        await finalizeProjectRuntime(paused, projectName)
        return readProjectWorkspace()
      }
      stopWorkflowTicker()
      await supervisor.setStrategyPaused(true)
      showProjectSupervisor(projectId)
      publishProjectRuntimeEvent(
        'project-runtime-paused',
        `${projectName}; runtimeId=${runtimeId}; manual-takeover=true${
          reason ? `; reason=${reason}` : ''
        }`
      )
      return readProjectWorkspace()
    } catch (error) {
      const latest = (await projectRuntimeStore.read()).runtimes.find(
        ({ runtime }) => runtime.runtimeId === runtimeId
      )
      if (latest?.runtime.status !== 'paused') {
        projectScheduler?.releasePausedRuntime(runtimeId)
        projectScheduler?.resume(projectId)
      }
      throw error
    }
  }
  const pendingAutomaticTakeovers = new Set<string>()
  requestManualTakeover = (projectId, reason, category) => {
    if (pendingAutomaticTakeovers.has(projectId)) {
      return
    }
    pendingAutomaticTakeovers.add(projectId)
    void enqueueSupervisorOperation(async () => {
      const state = await projectRuntimeStore?.read()
      const runtime = [...(state?.runtimes ?? [])]
        .reverse()
        .find(
          ({ runtime: candidate }) =>
            candidate.projectId === projectId &&
            !isTerminalProjectRuntime(candidate)
        )?.runtime
      if (!runtime || runtime.status === 'paused') {
        return
      }
      await pauseProjectRuntime(projectId, reason, category)
    })
      .catch((error: unknown) => {
        console.error('自动请求人工接管失败', error)
      })
      .finally(() => {
        pendingAutomaticTakeovers.delete(projectId)
      })
  }
  const resumeProjectRuntime = async (
    projectId: string
  ): Promise<ProjectWorkspaceSnapshot> => {
    if (!projectStore || !projectRuntimeStore || !projectScheduler) {
      throw new Error('Project Runtime 依赖当前不可用')
    }
    const state = await projectRuntimeStore.read()
    const envelope = [...state.runtimes]
      .reverse()
      .find(
        ({ runtime }) =>
          runtime.projectId === projectId && runtime.status === 'paused'
      )
    if (!envelope) {
      throw new Error('没有可恢复的 paused Project Runtime')
    }
    const { runtimeId } = envelope.runtime
    const projectName =
      (await projectStore.read()).projects.find(
        (project) => project.id === projectId
      )?.name ?? envelope.projectSnapshot.name
    const background = backgroundProjectRuntimes.get(runtimeId)
    if (background) {
      const resumed = await background.resume()
      projectScheduler.releasePausedRuntime(runtimeId, true)
      projectScheduler.resume(projectId)
      showProjectSupervisor(projectId)
      publish({
        sequence: 0,
        type: 'project-runtime-resumed',
        timestamp: new Date().toISOString(),
        url: background.supervisor.getSnapshot().url,
        detail: `${projectName}; runtimeId=${runtimeId}`,
        projectId: resumed.projectId,
        runtimeId
      })
      return readProjectWorkspace()
    }

    if (activeWorkflowEngine?.runtimeId === runtimeId) {
      const engine = activeWorkflowEngine
      const resumed = await engine.resume()
      currentProjectRuntime = structuredClone(resumed)
      try {
        await supervisor.setStrategyPaused(false)
      } catch (error) {
        currentProjectRuntime = await engine
          .pause()
          .catch(() => currentProjectRuntime)
        await supervisor.setStrategyPaused(true).catch(() => undefined)
        throw error
      }
      startWorkflowTicker(engine)
      projectScheduler.releasePausedRuntime(runtimeId, true)
      projectScheduler.resume(projectId)
      showProjectSupervisor(projectId)
      publishProjectRuntimeEvent(
        'project-runtime-resumed',
        `${projectName}; runtimeId=${runtimeId}`
      )
      return readProjectWorkspace()
    }

    await projectScheduler.requestResume(projectId)
    showProjectSupervisor(projectId)
    return readProjectWorkspace()
  }
  const stopProjectRuntime = async (
    projectId: string
  ): Promise<ProjectWorkspaceSnapshot> => {
    if (!projectStore || !projectRuntimeStore) {
      throw new Error('Project Runtime 依赖当前不可用')
    }
    const runtimeState = await projectRuntimeStore.read()
    const running =
      runtimeState.runtimes.find(
        ({ runtime }) =>
          runtime.projectId === projectId &&
          runtime.status !== 'queued' &&
          !isTerminalProjectRuntime(runtime)
      ) ??
      runtimeState.runtimes.find(
        ({ runtime }) =>
          runtime.projectId === projectId && runtime.status === 'queued'
      )
    if (!running) {
      throw new Error('没有正在运行的 Project Runtime')
    }
    projectScheduler?.suspend(running.runtime.projectId)
    const projectName =
      (await projectStore.read()).projects.find(
        (project) => project.id === running.runtime.projectId
      )?.name ?? running.projectSnapshot.name
    try {
      const background = backgroundProjectRuntimes.get(
        running.runtime.runtimeId
      )
      if (background) {
        const runtime = await background.cancel()
        await finalizeBackgroundProjectRuntime(runtime, projectName)
        return readProjectWorkspace()
      }
      const runtime =
        activeWorkflowEngine?.runtimeId === running.runtime.runtimeId
          ? await activeWorkflowEngine.cancel()
          : (
              await projectRuntimeStore.transition(
                running.runtime.runtimeId,
                'cancelled',
                {
                  lastError: '用户停止 Project Runtime',
                  lastFailureCategory: 'cancelled'
                }
              )
            ).runtime
      if (activeWorkflowEngine?.runtimeId === runtime.runtimeId) {
        await finalizeProjectRuntime(runtime, projectName)
      } else {
        publish({
          sequence: 0,
          type: 'project-runtime-stopped',
          timestamp: new Date().toISOString(),
          url:
            running.projectSnapshot.startupPages[0] ??
            supervisor.getSnapshot().url,
          detail:
            `${projectName}; status=${runtime.status}; ` +
            `runtimeId=${runtime.runtimeId}; queued=true`,
          projectId: runtime.projectId,
          runtimeId: runtime.runtimeId
        })
        projectScheduler?.notifyRuntimeTerminal(runtime)
      }
      return readProjectWorkspace()
    } catch (error) {
      const reason = formatUnknownError(error)
      activeStrategyDefinitions = []
      activeAllowedStrategyIds = new Set()
      await supervisor
        .setStrategyConfiguration([], new Set())
        .catch(() => undefined)
      publishProjectRuntimeEvent(
        'project-runtime-failed',
        `${projectName}; 停止失败：${reason}`
      )
      throw new Error(`Project Runtime 停止失败：${reason}`)
    }
  }

  const finalizeBackgroundProjectRuntime = async (
    runtime: ProjectRuntimeSnapshot,
    projectName: string
  ): Promise<void> => {
    const context = backgroundProjectRuntimes.get(runtime.runtimeId)
    if (!context) {
      return
    }
    backgroundProjectRuntimes.delete(runtime.runtimeId)
    const url = context.supervisor.getSnapshot().url
    if (visibleBackgroundRuntimeId === runtime.runtimeId) {
      visibleBackgroundRuntimeId = null
      applyPageViewVisibility()
    }
    context.dispose()
    publish({
      sequence: 0,
      type:
        runtime.status === 'failed'
          ? 'project-runtime-failed'
          : 'project-runtime-stopped',
      timestamp: new Date().toISOString(),
      url,
      detail:
        `${projectName}; status=${runtime.status}; ` +
        `runtimeId=${runtime.runtimeId}`,
      projectId: runtime.projectId,
      runtimeId: runtime.runtimeId
    })
    projectScheduler?.notifyRuntimeTerminal(runtime)
  }
  const startBackgroundProjectRuntime = async (
    envelope: ProjectRuntimeEnvelope
  ): Promise<void> => {
    if (!profileStore || !projectStore || !projectRuntimeStore) {
      throw new Error('后台 Project Runtime 依赖当前不可用')
    }
    const profileState = await profileStore.read()
    if (
      !profileState.profiles.some(
        (profile) => profile.id === envelope.projectSnapshot.profileId
      )
    ) {
      throw new Error(
        `Project 绑定的 Profile 不存在：${envelope.projectSnapshot.profileId}`
      )
    }
    const context = new BackgroundProjectRuntime({
      window,
      envelope,
      runtimeStore: projectRuntimeStore,
      strategyDefinitions: registryStrategyDefinitions,
      strategyPreloadPath: join(
        currentDirectory,
        '../preload/strategy-bootstrap.cjs'
      ),
      publish,
      bounds: browserBounds(),
      visible: false,
      onManualTakeoverRequested: (projectId, reason, category) =>
        requestManualTakeover?.(projectId, reason, category),
      onTerminal: (runtime) =>
        finalizeBackgroundProjectRuntime(runtime, envelope.projectSnapshot.name)
    })
    backgroundProjectRuntimes.set(envelope.runtime.runtimeId, context)
    try {
      const runtime = await context.start()
      if ((await projectStore.read()).activeProjectId === runtime.projectId) {
        showProjectSupervisor(runtime.projectId)
      }
      publish({
        sequence: 0,
        type: 'project-runtime-started',
        timestamp: new Date().toISOString(),
        url: context.supervisor.getSnapshot().url,
        detail:
          `${envelope.projectSnapshot.name}; ` +
          `runtimeId=${runtime.runtimeId}; background=true`,
        projectId: runtime.projectId,
        runtimeId: runtime.runtimeId
      })
    } catch (error) {
      backgroundProjectRuntimes.delete(envelope.runtime.runtimeId)
      context.dispose()
      throw error
    }
  }

  if (projectStore && projectRuntimeStore) {
    projectScheduler = new ProjectScheduler(
      projectStore,
      projectRuntimeStore,
      {
        startRuntime: (envelope) => {
          if (
            activeWorkflowEngine === null &&
            (currentProjectRuntime === null ||
              isTerminalProjectRuntime(currentProjectRuntime))
          ) {
            return enqueueSupervisorOperation(() =>
              startProjectRuntime(envelope.runtime.runtimeId)
            ).then(() => undefined)
          }
          return startBackgroundProjectRuntime(envelope)
        },
        timeoutRuntime: async (envelope, reason) => {
          const background = backgroundProjectRuntimes.get(
            envelope.runtime.runtimeId
          )
          if (background) {
            await background.fail('timeout', reason)
            return
          }
          await enqueueSupervisorOperation(() =>
            timeoutProjectRuntime(envelope.runtime.runtimeId, reason)
          )
        },
        reportError: (operation, error) => {
          console.error(`Project Scheduler ${operation} 失败`, error)
        }
      },
      { maxConcurrent: 2 }
    )
  }

  ipcMain.handle(IPC_CHANNELS.getSnapshot, async (event) => {
    assertTrustedSender(event.sender.id)
    return readSupervisor((current) => current.getSnapshot())
  })

  ipcMain.handle(IPC_CHANNELS.getMonitorSnapshot, async (event) => {
    assertTrustedSender(event.sender.id)
    return enqueueSupervisorOperation(async () => {
      const projectRuntimes = projectRuntimeStore
        ? (await projectRuntimeStore.read()).runtimes.map(({ runtime }) =>
            structuredClone(runtime)
          )
        : []
      const visibleSupervisor = getVisibleSupervisor()
      const allSupervisors = [
        supervisor,
        ...[...backgroundProjectRuntimes.values()].map(
          (runtime) => runtime.supervisor
        )
      ]
      const visibleRuntime = visibleBackgroundRuntimeId
        ? (backgroundProjectRuntimes
            .get(visibleBackgroundRuntimeId)
            ?.getRuntime() ?? null)
        : currentProjectRuntime
      return collectMonitorSnapshot(
        visibleSupervisor,
        eventCount,
        visibleRuntime,
        allSupervisors.filter((current) => current !== visibleSupervisor),
        projectRuntimes
      )
    })
  })

  ipcMain.handle(IPC_CHANNELS.getCapabilityPolicy, async (event) => {
    assertTrustedSender(event.sender.id)
    return readSupervisor((current) => current.getCapabilityPolicySnapshot())
  })

  ipcMain.handle(
    IPC_CHANNELS.setCapabilityPolicy,
    async (event, value: unknown) => {
      assertTrustedSender(event.sender.id)
      if (!capabilityStore) {
        throw new Error('Capability Store 当前不可用')
      }
      return enqueueSupervisorOperation(async () => {
        await assertProjectRuntimeInactive('修改全局 Capability')
        const policy = await capabilityStore.write(value)
        developmentCapabilityPolicy = policy
        activeCapabilityPolicy = policy
        return supervisor.setCapabilityPolicy(policy)
      })
    }
  )

  ipcMain.handle(IPC_CHANNELS.listTabs, async (event) => {
    assertTrustedSender(event.sender.id)
    return readSupervisor((current) => current.listTabs())
  })

  ipcMain.handle(IPC_CHANNELS.createTab, async (event, url: unknown) => {
    assertTrustedSender(event.sender.id)
    if (url !== undefined && typeof url !== 'string') {
      throw new TypeError('新标签页 URL 必须是字符串')
    }
    return enqueueSupervisorOperation(() =>
      getVisibleSupervisor().createTab(url)
    )
  })

  ipcMain.handle(IPC_CHANNELS.switchTab, async (event, tabId: unknown) => {
    assertTrustedSender(event.sender.id)
    if (typeof tabId !== 'string') {
      throw new TypeError('标签页 ID 必须是字符串')
    }
    return enqueueSupervisorOperation(() =>
      getVisibleSupervisor().switchTab(tabId)
    )
  })

  ipcMain.handle(IPC_CHANNELS.closeTab, async (event, tabId: unknown) => {
    assertTrustedSender(event.sender.id)
    if (typeof tabId !== 'string') {
      throw new TypeError('标签页 ID 必须是字符串')
    }
    return enqueueSupervisorOperation(() =>
      getVisibleSupervisor().closeTab(tabId)
    )
  })

  ipcMain.handle(IPC_CHANNELS.listProfiles, async (event) => {
    assertTrustedSender(event.sender.id)
    if (!profileStore) {
      throw new Error('Profile Store 当前不可用')
    }
    return toProfileSummaries(await profileStore.read())
  })

  ipcMain.handle(IPC_CHANNELS.createProfile, async (event, name: unknown) => {
    assertTrustedSender(event.sender.id)
    if (!profileStore || typeof name !== 'string') {
      throw new TypeError('Profile 名称必须是字符串')
    }
    return toProfileSummaries(await profileStore.create(name))
  })

  ipcMain.handle(
    IPC_CHANNELS.activateProfile,
    (event, nextProfileId: unknown) => {
      assertTrustedSender(event.sender.id)
      if (!profileStore || typeof nextProfileId !== 'string') {
        throw new TypeError('Profile ID 必须是字符串')
      }
      return enqueueSupervisorOperation(async () => {
        const state = await profileStore.read()
        if (!state.profiles.some((profile) => profile.id === nextProfileId)) {
          throw new Error(`Profile 不存在：${nextProfileId}`)
        }
        if (nextProfileId === activeProfileId) {
          return toProfileSummaries(state)
        }
        await assertProjectRuntimeInactive('切换 Profile')

        const previousProfileId = activeProfileId
        const previousUrl = supervisor.getSnapshot().url
        supervisor.dispose()
        activeProfileId = nextProfileId
        supervisor = createSupervisor(nextProfileId, previousUrl)

        try {
          await supervisor.start()
          layout()
          return toProfileSummaries(await profileStore.setActive(nextProfileId))
        } catch (error) {
          supervisor.dispose()
          activeProfileId = previousProfileId
          supervisor = createSupervisor(previousProfileId, previousUrl)
          await supervisor.start()
          layout()
          await profileStore.setActive(previousProfileId)
          throw error
        }
      })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.deleteProfile,
    (event, targetProfileId: unknown) => {
      assertTrustedSender(event.sender.id)
      if (!profileStore || typeof targetProfileId !== 'string') {
        throw new TypeError('Profile ID 必须是字符串')
      }
      return enqueueSupervisorOperation(async () => {
        const state = await profileStore.read()
        if (!state.profiles.some((profile) => profile.id === targetProfileId)) {
          throw new Error(`Profile 不存在：${targetProfileId}`)
        }
        if (targetProfileId === DEFAULT_PROFILE_ID) {
          throw new Error('默认 Profile 不能删除')
        }
        if (targetProfileId === state.activeProfileId) {
          throw new Error('活动 Profile 不能删除')
        }
        if (projectStore) {
          const references = (await projectStore.read()).projects.filter(
            (project) => project.profileId === targetProfileId
          )
          if (references.length > 0) {
            throw new Error(
              `Profile 正被 Project 引用：${references
                .map((project) => project.name)
                .join('、')}`
            )
          }
        }

        const targetSession = session.fromPartition(
          `persist:${targetProfileId}`
        )
        await Promise.all([
          targetSession.clearStorageData(),
          targetSession.clearCache(),
          targetSession.clearAuthCache()
        ])
        return toProfileSummaries(await profileStore.delete(targetProfileId))
      })
    }
  )

  ipcMain.handle(IPC_CHANNELS.getProjectWorkspace, (event) => {
    assertTrustedSender(event.sender.id)
    return readProjectWorkspace()
  })

  ipcMain.handle(
    IPC_CHANNELS.installAutomationPlayground,
    (event, profileId: unknown) => {
      assertTrustedSender(event.sender.id)
      if (
        !projectStore ||
        !profileStore ||
        !strategyStore ||
        !strategyPolicyStore ||
        typeof profileId !== 'string'
      ) {
        throw new TypeError('自动化验收模板安装参数无效')
      }
      return enqueueSupervisorOperation(async () => {
        await assertProjectRuntimeInactive('安装自动化验收模板')
        const [profileState, projectState, strategyState] = await Promise.all([
          profileStore.read(),
          projectStore.read(),
          strategyStore.read()
        ])
        if (
          !profileState.profiles.some((profile) => profile.id === profileId)
        ) {
          throw new Error(`Profile 不存在：${profileId}`)
        }
        if (
          projectState.projects.some(
            (project) => project.id === AUTOMATION_PLAYGROUND_PROJECT_ID
          ) ||
          strategyState.strategies.some(
            (definition) =>
              definition.manifest.id === AUTOMATION_PLAYGROUND_STRATEGY_ID
          )
        ) {
          throw new Error('自动化验收模板已经安装，请直接编辑现有配置')
        }

        const strategyWorkspace = await applyDevelopmentStrategyConfiguration(
          await strategyStore.save(createAutomationPlaygroundStrategyDraft()),
          await strategyPolicyStore.read()
        )
        await projectStore.save(
          createAutomationPlaygroundProjectDraft({
            profileId,
            outputRoot: join(
              app.getPath('downloads'),
              'AgenticBrowser',
              'automation-playground'
            )
          })
        )
        const selectedState = await projectStore.setActive(
          AUTOMATION_PLAYGROUND_PROJECT_ID
        )
        return {
          projectWorkspace: await buildProjectWorkspaceSnapshot(selectedState),
          strategyWorkspace
        }
      })
    }
  )

  ipcMain.handle(IPC_CHANNELS.saveProject, (event, value: unknown) => {
    assertTrustedSender(event.sender.id)
    if (!projectStore || !profileStore) {
      throw new Error('Project 或 Profile Store 当前不可用')
    }
    const draft: ProjectDraft | null = parseProjectDraft(value)
    if (!draft) {
      throw new TypeError('Project 定义格式无效')
    }
    return enqueueSupervisorOperation(async () => {
      await assertProjectRuntimeInactive('修改 Project')
      const profileState = await profileStore.read()
      if (
        !profileState.profiles.some((profile) => profile.id === draft.profileId)
      ) {
        throw new Error(`Profile 不存在：${draft.profileId}`)
      }
      await projectStore.save(draft)
      return buildProjectWorkspaceSnapshot(
        await projectStore.setActive(draft.id)
      )
    })
  })

  ipcMain.handle(IPC_CHANNELS.setActiveProject, (event, projectId: unknown) => {
    assertTrustedSender(event.sender.id)
    if (!projectStore || typeof projectId !== 'string') {
      throw new TypeError('Project ID 必须是字符串')
    }
    return enqueueSupervisorOperation(async () => {
      const state = await projectStore.setActive(projectId)
      showProjectSupervisor(projectId)
      return buildProjectWorkspaceSnapshot(state)
    })
  })

  ipcMain.handle(IPC_CHANNELS.deleteProject, (event, projectId: unknown) => {
    assertTrustedSender(event.sender.id)
    if (!projectStore || typeof projectId !== 'string') {
      throw new TypeError('Project ID 必须是字符串')
    }
    return enqueueSupervisorOperation(async () => {
      await assertProjectRuntimeInactive('删除 Project')
      return buildProjectWorkspaceSnapshot(await projectStore.delete(projectId))
    })
  })

  ipcMain.handle(
    IPC_CHANNELS.startProjectRuntime,
    async (event, projectId: unknown) => {
      assertTrustedSender(event.sender.id)
      if (typeof projectId !== 'string') {
        throw new TypeError('Project ID 必须是字符串')
      }
      if (!projectScheduler) {
        throw new Error('Project Scheduler 当前不可用')
      }
      await projectScheduler.requestManual(projectId)
      if (!projectStore) {
        throw new Error('Project Store 当前不可用')
      }
      const selectedState = await projectStore.setActive(projectId)
      showProjectSupervisor(projectId)
      return buildProjectWorkspaceSnapshot(selectedState)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.pauseProjectRuntime,
    (event, projectId: unknown) => {
      assertTrustedSender(event.sender.id)
      if (typeof projectId !== 'string') {
        throw new TypeError('Project ID 必须是字符串')
      }
      return enqueueSupervisorOperation(async () => {
        if (!projectStore) {
          throw new Error('Project Store 当前不可用')
        }
        await projectStore.setActive(projectId)
        return pauseProjectRuntime(projectId)
      })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.resumeProjectRuntime,
    (event, projectId: unknown) => {
      assertTrustedSender(event.sender.id)
      if (typeof projectId !== 'string') {
        throw new TypeError('Project ID 必须是字符串')
      }
      return enqueueSupervisorOperation(async () => {
        if (!projectStore) {
          throw new Error('Project Store 当前不可用')
        }
        await projectStore.setActive(projectId)
        return resumeProjectRuntime(projectId)
      })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.stopProjectRuntime,
    (event, projectId: unknown) => {
      assertTrustedSender(event.sender.id)
      if (typeof projectId !== 'string') {
        throw new TypeError('Project ID 必须是字符串')
      }
      return enqueueSupervisorOperation(() => stopProjectRuntime(projectId))
    }
  )

  ipcMain.handle(IPC_CHANNELS.getStartupSettings, (event) => {
    assertTrustedSender(event.sender.id)
    return getStartupSettings()
  })

  ipcMain.handle(IPC_CHANNELS.setOpenAtLogin, (event, enabled: unknown) => {
    assertTrustedSender(event.sender.id)
    if (typeof enabled !== 'boolean') {
      throw new TypeError('开机启动设置必须是布尔值')
    }
    return setOpenAtLogin(enabled)
  })

  ipcMain.handle(IPC_CHANNELS.getStrategyWorkspace, (event) => {
    assertTrustedSender(event.sender.id)
    return getStrategyWorkspaceSnapshot()
  })

  ipcMain.handle(IPC_CHANNELS.saveStrategy, (event, draft: unknown) => {
    assertTrustedSender(event.sender.id)
    if (!strategyStore || !strategyPolicyStore) {
      throw new Error('Strategy Store 当前不可用')
    }
    return enqueueSupervisorOperation(async () => {
      await assertProjectRuntimeInactive('修改 Strategy')
      return applyDevelopmentStrategyConfiguration(
        await strategyStore.save(draft),
        await strategyPolicyStore.read()
      )
    })
  })

  ipcMain.handle(
    IPC_CHANNELS.setStrategyEnabled,
    (event, strategyId: unknown, enabled: unknown) => {
      assertTrustedSender(event.sender.id)
      if (
        !strategyStore ||
        !strategyPolicyStore ||
        typeof strategyId !== 'string' ||
        typeof enabled !== 'boolean'
      ) {
        throw new TypeError('Strategy 启停参数无效')
      }
      return enqueueSupervisorOperation(async () => {
        await assertProjectRuntimeInactive('启停 Strategy')
        return applyDevelopmentStrategyConfiguration(
          await strategyStore.setEnabled(strategyId, enabled),
          await strategyPolicyStore.read()
        )
      })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.setStrategyAllowed,
    (event, strategyId: unknown, allowed: unknown) => {
      assertTrustedSender(event.sender.id)
      if (
        !strategyStore ||
        !strategyPolicyStore ||
        typeof strategyId !== 'string' ||
        typeof allowed !== 'boolean'
      ) {
        throw new TypeError('Strategy allowlist 参数无效')
      }
      return enqueueSupervisorOperation(async () => {
        await assertProjectRuntimeInactive('修改开发 allowlist')
        const state = await strategyStore.read()
        if (
          !state.strategies.some(
            (definition) => definition.manifest.id === strategyId
          )
        ) {
          throw new Error(`Strategy 不存在：${strategyId}`)
        }
        return applyDevelopmentStrategyConfiguration(
          state,
          await strategyPolicyStore.setAllowed(strategyId, allowed)
        )
      })
    }
  )

  ipcMain.handle(IPC_CHANNELS.deleteStrategy, (event, strategyId: unknown) => {
    assertTrustedSender(event.sender.id)
    if (
      !strategyStore ||
      !strategyPolicyStore ||
      typeof strategyId !== 'string'
    ) {
      throw new TypeError('Strategy 删除参数无效')
    }
    return enqueueSupervisorOperation(async () => {
      await assertProjectRuntimeInactive('删除 Strategy')
      const state = await strategyStore.delete(strategyId)
      const policy = await strategyPolicyStore.remove(strategyId)
      return applyDevelopmentStrategyConfiguration(state, policy)
    })
  })

  ipcMain.handle(IPC_CHANNELS.navigate, async (event, url: unknown) => {
    assertTrustedSender(event.sender.id)
    if (typeof url !== 'string') {
      throw new TypeError('导航 URL 必须是字符串')
    }

    return enqueueSupervisorOperation(() =>
      getVisibleSupervisor().navigate(url)
    )
  })

  ipcMain.handle(IPC_CHANNELS.reload, async (event, options: unknown) => {
    assertTrustedSender(event.sender.id)
    const normalized: ReloadOptions = {
      ignoreCache:
        typeof options === 'object' &&
        options !== null &&
        'ignoreCache' in options &&
        options.ignoreCache === true
    }
    return enqueueSupervisorOperation(() =>
      getVisibleSupervisor().reload(normalized)
    )
  })

  ipcMain.handle(
    IPC_CHANNELS.setPageViewsVisible,
    (event, visible: unknown): void => {
      assertTrustedSender(event.sender.id)
      if (typeof visible !== 'boolean') {
        throw new TypeError('视图可见性必须是布尔值')
      }
      pageOverlayVisible = !visible
      applyPageViewVisibility()
    }
  )

  let shutdownPrepared = false
  const prepareForShutdown = async (): Promise<void> => {
    if (shutdownPrepared) {
      return
    }
    shutdownPrepared = true
    shellEventsEnabled = false
    stopWorkflowTicker()
    projectScheduler?.dispose()
    projectScheduler = null
    handleStrategyDomainEvent = null

    let pendingOperations: Promise<void>
    do {
      pendingOperations = supervisorOperationQueue
      await pendingOperations
    } while (pendingOperations !== supervisorOperationQueue)

    await Promise.all([
      supervisor.prepareForShutdown(),
      ...[...backgroundProjectRuntimes.values()].map((runtime) =>
        runtime.prepareForShutdown()
      )
    ])
  }

  window.on('resize', layout)
  window.on('closed', () => {
    shellEventsEnabled = false
    stopWorkflowTicker()
    projectScheduler?.dispose()
    projectScheduler = null
    handleStrategyDomainEvent = null
    void eventLog?.flush()
    const removeIpcHandlers = (): void => {
      ipcMain.removeHandler(IPC_CHANNELS.getSnapshot)
      ipcMain.removeHandler(IPC_CHANNELS.getMonitorSnapshot)
      ipcMain.removeHandler(IPC_CHANNELS.getCapabilityPolicy)
      ipcMain.removeHandler(IPC_CHANNELS.setCapabilityPolicy)
      ipcMain.removeHandler(IPC_CHANNELS.listTabs)
      ipcMain.removeHandler(IPC_CHANNELS.createTab)
      ipcMain.removeHandler(IPC_CHANNELS.switchTab)
      ipcMain.removeHandler(IPC_CHANNELS.closeTab)
      ipcMain.removeHandler(IPC_CHANNELS.listProfiles)
      ipcMain.removeHandler(IPC_CHANNELS.createProfile)
      ipcMain.removeHandler(IPC_CHANNELS.activateProfile)
      ipcMain.removeHandler(IPC_CHANNELS.deleteProfile)
      ipcMain.removeHandler(IPC_CHANNELS.getProjectWorkspace)
      ipcMain.removeHandler(IPC_CHANNELS.installAutomationPlayground)
      ipcMain.removeHandler(IPC_CHANNELS.saveProject)
      ipcMain.removeHandler(IPC_CHANNELS.setActiveProject)
      ipcMain.removeHandler(IPC_CHANNELS.deleteProject)
      ipcMain.removeHandler(IPC_CHANNELS.startProjectRuntime)
      ipcMain.removeHandler(IPC_CHANNELS.pauseProjectRuntime)
      ipcMain.removeHandler(IPC_CHANNELS.resumeProjectRuntime)
      ipcMain.removeHandler(IPC_CHANNELS.stopProjectRuntime)
      ipcMain.removeHandler(IPC_CHANNELS.getStartupSettings)
      ipcMain.removeHandler(IPC_CHANNELS.setOpenAtLogin)
      ipcMain.removeHandler(IPC_CHANNELS.getStrategyWorkspace)
      ipcMain.removeHandler(IPC_CHANNELS.saveStrategy)
      ipcMain.removeHandler(IPC_CHANNELS.setStrategyEnabled)
      ipcMain.removeHandler(IPC_CHANNELS.setStrategyAllowed)
      ipcMain.removeHandler(IPC_CHANNELS.deleteStrategy)
      ipcMain.removeHandler(IPC_CHANNELS.navigate)
      ipcMain.removeHandler(IPC_CHANNELS.reload)
    }

    if (shellView.webContents.isDestroyed()) {
      removeIpcHandlers()
    } else {
      shellView.webContents.once('destroyed', removeIpcHandlers)
      shellView.webContents.close()
    }

    if (shutdownPrepared) {
      for (const runtime of backgroundProjectRuntimes.values()) {
        runtime.dispose(true)
      }
      backgroundProjectRuntimes.clear()
      supervisor.dispose(true)
    } else {
      void enqueueSupervisorOperation(() => {
        for (const runtime of backgroundProjectRuntimes.values()) {
          runtime.dispose(true)
        }
        backgroundProjectRuntimes.clear()
        supervisor.dispose(true)
      })
    }

    if (mainWindow === window) {
      mainWindow = null
    }
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    await shellView.webContents.loadURL(rendererUrl)
  } else {
    await shellView.webContents.loadFile(
      join(currentDirectory, '../renderer/index.html')
    )
  }

  layout()
  await supervisor.start()
  await projectScheduler?.start()
  if (projectStore) {
    showProjectSupervisor((await projectStore.read()).activeProjectId)
  }
  if (show) {
    window.show()
  }
  mainWindow = window

  return {
    window,
    shellView,
    get supervisor() {
      return supervisor
    },
    events,
    getEventCount: () => eventCount,
    suppressShellEvents: () => {
      shellEventsEnabled = false
    },
    prepareForShutdown
  }
}

function collectMonitorSnapshot(
  supervisor: BrowserTabManager,
  browserEventCount: number,
  projectRuntime: ProjectRuntimeSnapshot | null = null,
  additionalSupervisors: BrowserTabManager[] = [],
  projectRuntimes: ProjectRuntimeSnapshot[] = []
): MonitorSnapshot {
  return buildMonitorSnapshot({
    supervisor,
    additionalSupervisors,
    browserEventCount,
    projectRuntime,
    projectRuntimes,
    processes: app.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      cpuPercent: metric.cpu.percentCPUUsage,
      workingSetBytes: metric.memory.workingSetSize * 1024
    }))
  })
}

if (runApplication) {
  getMainProcessHeartbeat()?.start()
  void app
    .whenReady()
    .then(async () => {
      app.setAppUserModelId('com.firoyang.agenticbrowser')
      const checkpointStore = createCheckpointStore()
      const eventLog =
        smokeTest ||
        recoverySmokeTest ||
        strategyFaultSmokeTest ||
        strategyWorkspaceSmokeTest ||
        projectDownloadSmokeTest ||
        projectConcurrencySmokeTest ||
        projectTakeoverSmokeTest ||
        automationPlaygroundSmokeTest
          ? undefined
          : new StructuredEventLog(
              join(app.getPath('userData'), 'logs', 'browser-events.jsonl')
            )
      const restoredCheckpoint = checkpointStore
        ? await checkpointStore.read()
        : null
      automatedDownloadDirectory =
        smokeTest ||
        recoverySmokeTest ||
        strategyFaultSmokeTest ||
        strategyWorkspaceSmokeTest ||
        projectDownloadSmokeTest ||
        projectConcurrencySmokeTest ||
        projectTakeoverSmokeTest ||
        automationPlaygroundSmokeTest
          ? join(app.getPath('temp'), `agentic-browser-smoke-${process.pid}`)
          : null
      const profileStore = new ProfileStore(
        join(
          automatedDownloadDirectory ?? app.getPath('userData'),
          'config',
          'profiles.json'
        )
      )
      const projectStore = new ProjectStore(
        join(
          automatedDownloadDirectory ?? app.getPath('userData'),
          'config',
          'projects.json'
        )
      )
      const projectRuntimeStore = new ProjectRuntimeStore(
        join(
          automatedDownloadDirectory ?? app.getPath('userData'),
          'runtime',
          'project-runtimes.json'
        )
      )
      await projectRuntimeStore.recoverInterrupted()
      const profileState = await profileStore.read()
      const profileId = profileState.activeProfileId
      const compatibleCheckpoint =
        restoredCheckpoint?.profileId === profileId ? restoredCheckpoint : null
      const capabilityStore = new CapabilityStore(
        join(
          automatedDownloadDirectory ?? app.getPath('userData'),
          'config',
          'capabilities.json'
        )
      )
      const capabilityPolicy =
        smokeTest ||
        recoverySmokeTest ||
        strategyFaultSmokeTest ||
        strategyWorkspaceSmokeTest ||
        projectDownloadSmokeTest ||
        projectConcurrencySmokeTest ||
        projectTakeoverSmokeTest ||
        automationPlaygroundSmokeTest
          ? createCapabilityPolicy()
          : await capabilityStore.read()
      const strategyStore = new StrategyStore(
        join(
          automatedDownloadDirectory ?? app.getPath('userData'),
          'config',
          'strategies.json'
        )
      )
      const strategyPolicyStore = new StrategyPolicyStore(
        join(
          automatedDownloadDirectory ?? app.getPath('userData'),
          'config',
          'strategy-policy.json'
        )
      )
      const strategyState = await strategyStore.read()
      const strategyPolicy = await strategyPolicyStore.read()
      phaseZeroProbe =
        smokeTest ||
        recoverySmokeTest ||
        strategyFaultSmokeTest ||
        strategyWorkspaceSmokeTest ||
        projectDownloadSmokeTest ||
        projectConcurrencySmokeTest ||
        projectTakeoverSmokeTest
          ? await startPhaseZeroProbeServer()
          : null
      const watchdogSmokeUrl = process.env.AGENTIC_WATCHDOG_SMOKE_URL
      if (watchdogSmokeChild && !watchdogSmokeUrl && !compatibleCheckpoint) {
        throw new Error('Watchdog smoke 缺少初始 URL')
      }
      const projectDownloadFaultSmokeUrl =
        process.env.AGENTIC_PROJECT_DOWNLOAD_FAULT_NETWORK_URL
      const projectDownloadRendererSmokeUrl =
        process.env.AGENTIC_PROJECT_DOWNLOAD_RENDERER_URL

      const initialUrl =
        phaseZeroProbe?.topUrl ??
        projectDownloadFaultSmokeUrl ??
        projectDownloadRendererSmokeUrl ??
        compatibleCheckpoint?.url ??
        watchdogSmokeUrl
      const strategyDefinitions = smokeTest
        ? createStrategySmokeDefinitions()
        : strategyFaultSmokeTest
          ? [createStrategyFaultSmokeDefinition()]
          : projectDownloadSmokeTest
            ? [createProjectDownloadSmokeDefinition()]
            : projectConcurrencySmokeTest
              ? [createProjectConcurrencySmokeDefinition()]
              : projectTakeoverSmokeTest
                ? [createProjectTakeoverSmokeDefinition()]
                : strategyState.strategies
      const allowedStrategyIds =
        smokeTest || strategyFaultSmokeTest
          ? new Set(strategyDefinitions.map((item) => item.manifest.id))
          : new Set(strategyPolicy.developmentAllowedStrategyIds)
      const runtime = await createMainWindow({
        show:
          !watchdogSmokeChild &&
          !projectDownloadRecoverySmokeChild &&
          !projectDownloadFaultSmokeChild &&
          !projectDownloadRendererRecoverySmokeChild &&
          !recoverySmokeTest &&
          !strategyFaultSmokeTest &&
          !strategyWorkspaceSmokeTest &&
          !projectDownloadSmokeTest &&
          !projectConcurrencySmokeTest &&
          !projectTakeoverSmokeTest &&
          !automationPlaygroundSmokeTest,
        phaseZeroProbe: smokeTest,
        healthMonitoring: !smokeTest && !strategyFaultSmokeTest,
        ...(initialUrl ? { initialUrl } : {}),
        profileId,
        ...(checkpointStore ? { checkpointStore } : {}),
        ...(eventLog ? { eventLog } : {}),
        capabilityStore,
        capabilityPolicy,
        downloadRoot: join(
          automatedDownloadDirectory ?? app.getPath('userData'),
          'downloads'
        ),
        profileStore,
        projectStore,
        projectRuntimeStore,
        strategyStore,
        strategyPolicyStore,
        strategyDefinitions,
        allowedStrategyIds
      })

      if (smokeTest) {
        runtime.window.setAlwaysOnTop(true)
        runtime.window.show()
        runtime.window.focus()
        if (!phaseZeroProbe) {
          throw new Error('Phase 0 probe server 未启动')
        }

        await waitForStrategyRuntime(runtime.supervisor, 4)
        const generationBeforeHotReload =
          runtime.supervisor.getSnapshot().generation
        const hotReloadDefinitions = createStrategySmokeDefinitions().map(
          (definition) =>
            definition.manifest.id === 'smoke-document-start'
              ? {
                  ...definition,
                  manifest: {
                    ...definition.manifest,
                    version: '0.1.1'
                  },
                  updatedAt: '2026-10-15T00:01:00.000Z'
                }
              : definition
        )
        await runtime.supervisor.setStrategyConfiguration(
          hotReloadDefinitions,
          new Set(hotReloadDefinitions.map((item) => item.manifest.id))
        )
        await waitForStrategyRuntime(runtime.supervisor, 4)
        const generationAfterHotReload =
          runtime.supervisor.getSnapshot().generation
        const beforeCrash = await runtime.supervisor.collectDiagnostics(
          runtime.shellView.webContents.id
        )
        const framesBeforeCrash =
          await runtime.supervisor.collectFrameDiagnostics()
        const strategiesBeforeCrash =
          runtime.supervisor.getStrategyRuntimeSnapshot()
        const profileCookieBeforeCrash =
          await runtime.supervisor.hasProfileCookie('agentic_phase0_session')
        const capture = await runtime.supervisor.benchmarkCapture()
        const interactionDuringCapture =
          await runtime.supervisor.benchmarkInteractionDuringCapture()
        const multiViewCapture =
          await runtime.supervisor.benchmarkMultiViewCapture()
        const heartbeatStall = await runtime.supervisor.probeHeartbeatStall()
        await runtime.supervisor.forceCrashAndWait()
        await waitForStrategyRuntime(runtime.supervisor, 4)
        const afterCrash = await runtime.supervisor.collectDiagnostics(
          runtime.shellView.webContents.id
        )
        const framesAfterCrash =
          await runtime.supervisor.collectFrameDiagnostics()
        const strategiesAfterCrash =
          runtime.supervisor.getStrategyRuntimeSnapshot()
        const profileCookieAfterCrash =
          await runtime.supervisor.hasProfileCookie('agentic_phase0_session')
        let failedNavigationRejected = false
        try {
          await runtime.supervisor.navigate(
            new URL('/disconnect', phaseZeroProbe.topUrl).toString()
          )
        } catch {
          failedNavigationRejected = true
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
        const mainProcessId = framesBeforeCrash.find(
          (frame) => frame.isMainFrame
        )?.processId
        const expectedLabels = new Set(['top', 'same-origin', 'cross-origin'])
        const injectedBeforeCrash = framesBeforeCrash.filter(
          (frame) =>
            frame.observation?.probeVisibleAtInline === true &&
            frame.observation.preloadReadyState === 'loading' &&
            frame.observation.strategyMarkerAtInline === 'loading' &&
            frame.observation.strategyNodeAtInline === 'isolated' &&
            frame.observation.strategyPrivateVisibleAtInline === false &&
            frame.currentStrategy.privateVisible === false &&
            expectedLabels.has(frame.observation.label)
        )
        const injectedAfterCrash = framesAfterCrash.filter(
          (frame) =>
            frame.observation?.probeVisibleAtInline === true &&
            frame.observation.preloadReadyState === 'loading' &&
            frame.observation.strategyMarkerAtInline === 'loading' &&
            frame.observation.strategyNodeAtInline === 'isolated' &&
            frame.observation.strategyPrivateVisibleAtInline === false &&
            frame.currentStrategy.privateVisible === false &&
            expectedLabels.has(frame.observation.label)
        )
        const topStrategyBeforeCrash = framesBeforeCrash.find(
          (frame) => frame.isMainFrame
        )?.currentStrategy
        const topStrategyAfterCrash = framesAfterCrash.find(
          (frame) => frame.isMainFrame
        )?.currentStrategy
        const oopifObserved = framesBeforeCrash.some(
          (frame) => !frame.isMainFrame && frame.processId !== mainProcessId
        )
        const observedEventTypes = new Set(
          runtime.events.map((event) => event.type)
        )
        const expectedEventTypes: BrowserEvent['type'][] = [
          'created',
          'navigation-started',
          'navigation-finished',
          'load-started',
          'load-finished',
          'load-failed',
          'renderer-gone',
          'recreated',
          'strategy-started',
          'strategy-ready',
          'strategy-log',
          'strategy-event',
          'strategy-reloaded'
        ]
        const passed =
          beforeCrash.distinctWebContents &&
          beforeCrash.preferences.sandbox &&
          beforeCrash.preferences.contextIsolation &&
          !beforeCrash.preferences.nodeIntegration &&
          beforeCrash.preferences.nodeIntegrationInSubFrames &&
          !beforeCrash.preferences.backgroundThrottling &&
          !beforeCrash.pageWorld.hasNodeProcess &&
          !beforeCrash.pageWorld.hasRequire &&
          !beforeCrash.pageWorld.hasBrowserShellBridge &&
          beforeCrash.strategyPreloadRegistered &&
          injectedBeforeCrash.length === expectedLabels.size &&
          injectedAfterCrash.length === expectedLabels.size &&
          strategiesBeforeCrash.activeCount === expectedLabels.size + 1 &&
          strategiesAfterCrash.activeCount === expectedLabels.size + 1 &&
          strategiesBeforeCrash.entries.every(
            (entry) => entry.status === 'running'
          ) &&
          strategiesBeforeCrash.entries
            .filter((entry) => entry.strategyId === 'smoke-document-start')
            .every((entry) => entry.version === '0.1.1') &&
          strategiesAfterCrash.entries.every(
            (entry) => entry.status === 'running'
          ) &&
          generationAfterHotReload > generationBeforeHotReload &&
          topStrategyBeforeCrash?.nodeMarker === 'network-ok' &&
          topStrategyBeforeCrash.mainWorldMarker === 'allowed' &&
          topStrategyAfterCrash?.nodeMarker === 'network-ok' &&
          topStrategyAfterCrash.mainWorldMarker === 'allowed' &&
          oopifObserved &&
          profileCookieBeforeCrash &&
          profileCookieAfterCrash &&
          capture.emptyFrames === 0 &&
          capture.achievedFps >= 9.5 &&
          capture.ring.frameCount === 10 &&
          capture.ring.byteLength <= 1024 * 1024 &&
          capture.ring.evictedFrames === 10 &&
          interactionDuringCapture.captureFps >= 9.5 &&
          interactionDuringCapture.duringCapture.p95Ms < 100 &&
          interactionDuringCapture.p95DeltaMs < 100 &&
          multiViewCapture.distinctWebContents &&
          multiViewCapture.auxiliaryResponsive &&
          multiViewCapture.auxiliaryTickAdvanced &&
          multiViewCapture.emptyFrames === 0 &&
          multiViewCapture.achievedFps >= 9 &&
          heartbeatStall.stallDetected &&
          heartbeatStall.recovered &&
          heartbeatStall.frozenEvidence.frozen &&
          heartbeatStall.frozenEvidence.frameCount === 3 &&
          heartbeatStall.frozenEvidence.byteLength > 0 &&
          failedNavigationRejected &&
          expectedEventTypes.every((eventType) =>
            observedEventTypes.has(eventType)
          ) &&
          afterCrash.generation > beforeCrash.generation

        const result = {
          passed,
          beforeCrash,
          afterCrash,
          framesBeforeCrash,
          framesAfterCrash,
          strategiesBeforeCrash,
          strategiesAfterCrash,
          generationBeforeHotReload,
          generationAfterHotReload,
          oopifObserved,
          profileCookieBeforeCrash,
          profileCookieAfterCrash,
          failedNavigationRejected,
          observedEventTypes: [...observedEventTypes],
          heartbeatStall,
          capture,
          interactionDuringCapture,
          multiViewCapture
        }
        writeSmokeResultFile(smokeResultTargets.smoke, result)
        console.log(`AGENTIC_BROWSER_SMOKE ${JSON.stringify(result)}`)

        runtime.window.close()
        await phaseZeroProbe?.close()
        phaseZeroProbe = null
        cleanupAutomatedDownloads(automatedDownloadDirectory)
        app.exit(passed ? 0 : 1)
        return
      }

      if (projectConcurrencySmokeTest) {
        if (!phaseZeroProbe || !automatedDownloadDirectory) {
          throw new Error('Project concurrency smoke 环境未初始化')
        }
        const result = await runProjectConcurrencySmoke(
          runtime,
          phaseZeroProbe,
          join(automatedDownloadDirectory, 'concurrency-output')
        )
        writeSmokeResultFile(smokeResultTargets.projectConcurrency, result)
        console.log(
          `AGENTIC_BROWSER_PROJECT_CONCURRENCY_SMOKE ${JSON.stringify(result)}`
        )
        await closeSmokeRuntime(runtime)
        await phaseZeroProbe.close()
        phaseZeroProbe = null
        cleanupAutomatedDownloads(automatedDownloadDirectory)
        app.exit(result.passed === true ? 0 : 1)
        return
      }

      if (projectTakeoverSmokeTest) {
        if (!phaseZeroProbe || !automatedDownloadDirectory) {
          throw new Error('Project takeover smoke 环境未初始化')
        }
        const result = await runProjectTakeoverSmoke(
          runtime,
          phaseZeroProbe,
          profileId,
          join(automatedDownloadDirectory, 'takeover-output')
        )
        writeSmokeResultFile(smokeResultTargets.projectTakeover, result)
        console.log(
          `AGENTIC_BROWSER_PROJECT_TAKEOVER_SMOKE ${JSON.stringify(result)}`
        )
        await closeSmokeRuntime(runtime)
        await phaseZeroProbe.close()
        phaseZeroProbe = null
        cleanupAutomatedDownloads(automatedDownloadDirectory)
        app.exit(result.passed === true ? 0 : 1)
        return
      }

      if (automationPlaygroundSmokeTest) {
        if (!automatedDownloadDirectory) {
          throw new Error('公开站点自动化验收 smoke 环境未初始化')
        }
        const result = await runAutomationPlaygroundSmoke(
          runtime,
          join(automatedDownloadDirectory, 'automation-playground-output')
        )
        writeSmokeResultFile(smokeResultTargets.automationPlayground, result)
        console.log(
          `AGENTIC_BROWSER_AUTOMATION_PLAYGROUND_SMOKE ${JSON.stringify(
            result
          )}`
        )
        await closeSmokeRuntime(runtime)
        cleanupAutomatedDownloads(automatedDownloadDirectory)
        app.exit(result.passed === true ? 0 : 1)
        return
      }

      if (recoverySmokeTest) {
        if (!phaseZeroProbe) {
          throw new Error('Recovery smoke probe server 未启动')
        }
        const result = await runRecoverySmoke(runtime, phaseZeroProbe)
        writeSmokeResultFile(smokeResultTargets.recovery, result)
        console.log(`AGENTIC_BROWSER_RECOVERY_SMOKE ${JSON.stringify(result)}`)
        runtime.window.close()
        await phaseZeroProbe.close()
        phaseZeroProbe = null
        cleanupAutomatedDownloads(automatedDownloadDirectory)
        app.exit(result.passed === true ? 0 : 1)
        return
      }

      if (strategyFaultSmokeTest) {
        if (!phaseZeroProbe) {
          throw new Error('Strategy fault smoke probe server 未启动')
        }
        const result = await runStrategyFaultSmoke(runtime)
        writeSmokeResultFile(smokeResultTargets.strategyFault, result)
        console.log(
          `AGENTIC_BROWSER_STRATEGY_FAULT_SMOKE ${JSON.stringify(result)}`
        )
        await closeSmokeRuntime(runtime)
        await phaseZeroProbe.close()
        phaseZeroProbe = null
        cleanupAutomatedDownloads(automatedDownloadDirectory)
        app.exit(result.passed === true ? 0 : 1)
        return
      }

      if (strategyWorkspaceSmokeTest) {
        if (!phaseZeroProbe) {
          throw new Error('Strategy workspace smoke probe server 未启动')
        }
        const result = await runStrategyWorkspaceSmoke(runtime)
        writeSmokeResultFile(smokeResultTargets.strategyWorkspace, result)
        console.log(
          `AGENTIC_BROWSER_STRATEGY_WORKSPACE_SMOKE ${JSON.stringify(result)}`
        )
        await closeSmokeRuntime(runtime)
        await phaseZeroProbe.close()
        phaseZeroProbe = null
        cleanupAutomatedDownloads(automatedDownloadDirectory)
        app.exit(result.passed === true ? 0 : 1)
        return
      }

      if (projectDownloadSmokeTest) {
        if (!phaseZeroProbe || !automatedDownloadDirectory) {
          throw new Error('Project download smoke 环境未初始化')
        }
        const result = await runProjectDownloadSmoke(
          runtime,
          phaseZeroProbe,
          profileId,
          join(automatedDownloadDirectory, 'project-output')
        )
        writeSmokeResultFile(smokeResultTargets.projectDownload, result)
        console.log(
          `AGENTIC_BROWSER_PROJECT_DOWNLOAD_SMOKE ${JSON.stringify(result)}`
        )
        await closeSmokeRuntime(runtime)
        await phaseZeroProbe.close()
        phaseZeroProbe = null
        cleanupAutomatedDownloads(automatedDownloadDirectory)
        app.exit(result.passed === true ? 0 : 1)
        return
      }

      if (watchdogSmokeChild) {
        await runWatchdogSmokeChild(
          runtime,
          restoredCheckpoint,
          watchdogSmokeUrl
        )
        return
      }

      if (projectDownloadRecoverySmokeChild) {
        await runProjectDownloadRecoverySmokeChild(runtime, projectRuntimeStore)
        return
      }

      if (projectDownloadFaultSmokeChild) {
        await runProjectDownloadFaultSmokeChild(
          runtime,
          projectRuntimeStore,
          profileId
        )
        return
      }

      if (projectDownloadRendererRecoverySmokeChild) {
        await runProjectDownloadRendererRecoverySmokeChild(
          runtime,
          projectRuntimeStore,
          profileId
        )
        return
      }

      app.on('activate', () => {
        if (!mainWindow) {
          void createMainWindow()
        }
      })
    })
    .catch((error: unknown) => {
      const result = {
        passed: false,
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error)
      }
      writeSmokeResultFile(smokeResultTargets.smoke, result)
      writeSmokeResultFile(smokeResultTargets.recovery, result)
      writeSmokeResultFile(smokeResultTargets.strategyFault, result)
      writeSmokeResultFile(smokeResultTargets.strategyWorkspace, result)
      writeSmokeResultFile(smokeResultTargets.projectDownload, result)
      writeSmokeResultFile(smokeResultTargets.projectConcurrency, result)
      writeSmokeResultFile(smokeResultTargets.projectTakeover, result)
      writeSmokeResultFile(smokeResultTargets.automationPlayground, result)
      writeProjectDownloadFaultSmokeChildResult(result)
      writeProjectDownloadRendererSmokeChildResult(result)
      void phaseZeroProbe?.close()
      phaseZeroProbe = null
      cleanupAutomatedDownloads(automatedDownloadDirectory)
      void getMainProcessHeartbeat()?.stop()
      console.error(error)
      app.exit(1)
    })
}

app.on('before-quit', () => {
  void getMainProcessHeartbeat()?.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !automatedTestRun) {
    app.quit()
  }
})
