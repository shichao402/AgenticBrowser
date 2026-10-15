import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BaseWindow, ipcMain, session, WebContentsView } from 'electron'

import {
  IPC_CHANNELS,
  type BrowserEvent,
  type BrowserSnapshot,
  type CapabilityPolicy,
  type ContentFilterDefinition,
  type JsonValue,
  type KnowledgePlanetPilotInstallResult,
  type MonitorSnapshot,
  type ProjectDefinition,
  type ProjectDraft,
  type ProjectRuntimeSnapshot,
  type ProjectWorkspaceSnapshot,
  type ProfileSummary,
  type ReloadOptions,
  type WorkflowFailureCategory,
  type StrategyDefinition,
  type StrategyDraft,
  type StrategyWorkspaceSnapshot,
  type StartupSettings
} from '../shared/contracts'
import { writeJsonAtomic } from './atomic-file'
import { BackgroundProjectRuntime } from './background-project-runtime'
import { BrowserTabManager } from './browser-tab-manager'
import type {
  BrowserDownloadAdapter,
  BrowserDownloadRequest
} from './browser-supervisor'
import {
  CapabilityStore,
  createCapabilityPolicy
} from './capability-store'
import {
  BrowserCheckpointStore,
  type BrowserCheckpoint
} from './checkpoint-store'
import { MainProcessHeartbeat } from './main-process-heartbeat'
import {
  createKnowledgePlanetProjectDraft,
  createKnowledgePlanetStrategyDraft,
  KNOWLEDGE_PLANET_PROJECT_ID,
  KNOWLEDGE_PLANET_STRATEGY_ID
} from './knowledge-planet-pilot'
import {
  ProjectDownloadManager,
  type ProjectDownloadReservation
} from './project-download-manager'
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
import { StructuredEventLog } from './structured-event-log'
import {
  DEFAULT_PROFILE_ID,
  ProfileStore,
  type ProfileState
} from './profile-store'
import {
  StrategyPolicyStore,
  type StrategyPolicyState
} from './strategy-policy-store'
import {
  StrategyStore,
  type StrategyState
} from './strategy-store'
import {
  launchPackagedWatchdog,
  WATCHDOG_AUTOSTART_ARGUMENT
} from './watchdog-launcher'

const managedUserDataPath = process.env.AGENTIC_USER_DATA_PATH
if (managedUserDataPath) {
  mkdirSync(managedUserDataPath, { recursive: true })
  app.setPath('userData', managedUserDataPath)
}

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const SIDEBAR_WIDTH = 320
const TOOLBAR_HEIGHT = 104
const MIN_PAGE_SIZE = 240

let mainWindow: BaseWindow | null = null
const smokeTest = process.argv.includes('--smoke-test')
const recoverySmokeTest = process.argv.includes('--recovery-smoke-test')
const strategyFaultSmokeTest = process.argv.includes(
  '--strategy-fault-smoke-test'
)
const strategyWorkspaceSmokeTest = process.argv.includes(
  '--strategy-workspace-smoke-test'
)
const projectDownloadSmokeTest = process.argv.includes(
  '--project-download-smoke-test'
)
const projectConcurrencySmokeTest = process.argv.includes(
  '--project-concurrency-smoke-test'
)
const projectTakeoverSmokeTest = process.argv.includes(
  '--project-takeover-smoke-test'
)
const knowledgePlanetPilotSmokeTest = process.argv.includes(
  '--knowledge-planet-pilot-smoke-test'
)
const watchdogSmokeChild = process.argv.includes('--watchdog-smoke-child')
const smokeResultPath = join(process.cwd(), 'phase0-smoke-result.json')
const recoverySmokeResultPath = join(
  process.cwd(),
  'phase1-recovery-smoke-result.json'
)
const strategyFaultSmokeResultPath = join(
  process.cwd(),
  'phase2-strategy-fault-smoke-result.json'
)
const strategyWorkspaceSmokeResultPath = join(
  process.cwd(),
  'phase2-strategy-workspace-smoke-result.json'
)
const projectDownloadSmokeResultPath = join(
  process.cwd(),
  'phase3-project-download-smoke-result.json'
)
const projectConcurrencySmokeResultPath = join(
  process.cwd(),
  'phase3-project-concurrency-smoke-result.json'
)
const projectTakeoverSmokeResultPath = join(
  process.cwd(),
  'phase3-project-takeover-smoke-result.json'
)
const knowledgePlanetPilotSmokeResultPath = join(
  process.cwd(),
  'phase3-knowledge-planet-pilot-smoke-result.json'
)
let phaseZeroProbe: PhaseZeroProbeServer | null = null
let automatedDownloadDirectory: string | null = null
const watchdogRestartCount = parseNonNegativeInteger(
  process.env.AGENTIC_WATCHDOG_RESTART_COUNT
)
const mainProcessHeartbeat = process.env.AGENTIC_WATCHDOG_HEARTBEAT_PATH
  ? new MainProcessHeartbeat(
      process.env.AGENTIC_WATCHDOG_HEARTBEAT_PATH,
      process.env.AGENTIC_WATCHDOG_LAUNCH_ID ?? `unmanaged-${process.pid}`,
      watchdogRestartCount
    )
  : null
const runApplication = await prepareApplicationLaunch()

async function prepareApplicationLaunch(): Promise<boolean> {
  if (
    app.isPackaged &&
    process.env.AGENTIC_WATCHDOG_MANAGED !== '1'
  ) {
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

  if (!app.requestSingleInstanceLock()) {
    app.exit(0)
    return false
  }

  app.on('second-instance', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
  return true
}

function writeSmokeResult(result: unknown): void {
  if (smokeTest) {
    writeFileSync(smokeResultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  }
}

function writeRecoverySmokeResult(result: unknown): void {
  if (recoverySmokeTest) {
    writeFileSync(
      recoverySmokeResultPath,
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8'
    )
  }
}

function writeStrategyFaultSmokeResult(result: unknown): void {
  if (strategyFaultSmokeTest) {
    writeFileSync(
      strategyFaultSmokeResultPath,
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8'
    )
  }
}

function writeStrategyWorkspaceSmokeResult(result: unknown): void {
  if (strategyWorkspaceSmokeTest) {
    writeFileSync(
      strategyWorkspaceSmokeResultPath,
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8'
    )
  }
}

function writeProjectDownloadSmokeResult(result: unknown): void {
  if (projectDownloadSmokeTest) {
    writeFileSync(
      projectDownloadSmokeResultPath,
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8'
    )
  }
}

function writeProjectConcurrencySmokeResult(result: unknown): void {
  if (projectConcurrencySmokeTest) {
    writeFileSync(
      projectConcurrencySmokeResultPath,
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8'
    )
  }
}

function writeProjectTakeoverSmokeResult(result: unknown): void {
  if (projectTakeoverSmokeTest) {
    writeFileSync(
      projectTakeoverSmokeResultPath,
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8'
    )
  }
}

function writeKnowledgePlanetPilotSmokeResult(result: unknown): void {
  if (knowledgePlanetPilotSmokeTest) {
    writeFileSync(
      knowledgePlanetPilotSmokeResultPath,
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8'
    )
  }
}

interface MainWindowRuntime {
  window: BaseWindow
  shellView: WebContentsView
  supervisor: BrowserTabManager
  events: BrowserEvent[]
  getEventCount(): number
  suppressShellEvents(): void
}

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

async function createMainWindow(options: CreateMainWindowOptions = {}): Promise<MainWindowRuntime> {
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
    title: 'AgenticBrowser',
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
        projectTakeoverSmokeTest) &&
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
  let activeContentFilter = structuredClone(
    developmentContentFilter
  )
  let registryStrategyDefinitions = cloneStrategyDefinitions(
    strategyDefinitions ?? []
  )
  let developmentAllowedStrategyIds = new Set(
    allowedStrategyIds ?? []
  )
  let activeStrategyDefinitions = cloneStrategyDefinitions(
    registryStrategyDefinitions
  )
  let activeAllowedStrategyIds = new Set(
    developmentAllowedStrategyIds
  )
  let activeWorkflowEngine: ProjectWorkflowEngine | null = null
  let activeDownloadManager: ProjectDownloadManager | null = null
  let activeItemStore: ProjectItemStore | null = null
  let activeDownloadAdapter: BrowserDownloadAdapter | undefined
  let pendingManagedDownloads: Array<
    Extract<ProjectDownloadReservation, { kind: 'reserved' }>
  > = []
  let currentProjectRuntime: ProjectRuntimeSnapshot | null = null
  let projectScheduler: ProjectScheduler | null = null
  const backgroundProjectRuntimes = new Map<
    string,
    BackgroundProjectRuntime
  >()
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
  const createSupervisor = (
    nextProfileId: string,
    nextInitialUrl?: string
  ): BrowserTabManager =>
    new BrowserTabManager(window, (event) => {
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
    }, {
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
      onStrategyDomainEvent: (event) =>
        handleStrategyDomainEvent?.(event)
    })
  let supervisor = createSupervisor(activeProfileId, initialUrl)
  let visibleBackgroundRuntimeId: string | null = null

  const getVisibleSupervisor = (): BrowserTabManager => {
    if (visibleBackgroundRuntimeId) {
      const runtime = backgroundProjectRuntimes.get(
        visibleBackgroundRuntimeId
      )
      if (runtime) {
        return runtime.supervisor
      }
      visibleBackgroundRuntimeId = null
    }
    return supervisor
  }
  const showProjectSupervisor = (projectId: string | null): void => {
    const background = projectId
      ? [...backgroundProjectRuntimes.entries()].find(
          ([, runtime]) =>
            runtime.getRuntime().projectId === projectId
        )
      : undefined
    if (background) {
      supervisor.setVisible(false)
      for (const [runtimeId, runtime] of backgroundProjectRuntimes) {
        runtime.setVisible(runtimeId === background[0])
      }
      visibleBackgroundRuntimeId = background[0]
      return
    }
    for (const runtime of backgroundProjectRuntimes.values()) {
      runtime.setVisible(false)
    }
    visibleBackgroundRuntimeId = null
    supervisor.setVisible(true)
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
    developmentAllowedStrategyIds: [
      ...developmentAllowedStrategyIds
    ].sort()
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
      policy.developmentAllowedStrategyIds.filter((id) =>
        existingIds.has(id)
      )
    )
    activeStrategyDefinitions = cloneStrategyDefinitions(
      registryStrategyDefinitions
    )
    activeAllowedStrategyIds = new Set(
      developmentAllowedStrategyIds
    )
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
      state.projects.find(
        (project) => project.id === state.activeProjectId
      ) ?? null
    const runtimes = projectRuntimeStore
      ? (await projectRuntimeStore.read()).runtimes.map(
          ({ runtime }) => structuredClone(runtime)
        )
      : []
    return {
      projects: state.projects.map(cloneProjectDefinition),
      activeProjectId: state.activeProjectId,
      runtimes,
      strategyResolutions: activeProject
        ? resolveProjectStrategies(
            activeProject,
            registryStrategyDefinitions
          ).resolutions
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
      state?.runtimes.some(
        ({ runtime }) => !isTerminalProjectRuntime(runtime)
      )
    ) {
      throw new Error(
        `Project Runtime 运行期间不能${operation}；请先停止项目`
      )
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
          [request.sourceUrl, ...request.urlChain].map(
            normalizeComparableUrl
          )
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
            await handleStrategyDomainEvent?.({
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

    activeStrategyDefinitions = cloneStrategyDefinitions(
      resolved.definitions
    )
    activeAllowedStrategyIds = new Set(resolved.allowedStrategyIds)
    activeCapabilityPolicy = structuredClone(
      runtimeProject.capabilities
    )
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
        supervisor = createSupervisor(
          runtimeProject.profileId,
          startupUrl
        )
        if (visibleBackgroundRuntimeId) {
          supervisor.setVisible(false)
        }
        await supervisor.start()
        layout()
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
        if (
          starting &&
          !isTerminalProjectRuntime(starting.runtime)
        ) {
          const status =
            starting.runtime.status === 'queued'
              ? 'cancelled'
              : 'failed'
          currentProjectRuntime = (
            await projectRuntimeStore.transition(
              startingRuntimeId,
              status,
              {
                lastError: reason,
                lastFailureCategory: 'unknown'
              }
            )
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
          if (visibleBackgroundRuntimeId) {
            supervisor.setVisible(false)
          }
          await supervisor.start()
          layout()
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
    activeAllowedStrategyIds = new Set(
      developmentAllowedStrategyIds
    )
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
      (
        await projectStore?.read()
      )?.projects.find(
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
  const startWorkflowTicker = (
    engine: ProjectWorkflowEngine
  ): void => {
    stopWorkflowTicker()
    workflowTickTimer = setInterval(() => {
      if (
        workflowTickInFlight ||
        activeWorkflowEngine !== engine
      ) {
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
        .catch((error: unknown) =>
          handleWorkflowFailure(engine, error)
        )
        .finally(() => {
          workflowTickInFlight = false
        })
    }, 1_000)
    workflowTickTimer.unref()
  }
  handleStrategyDomainEvent = async (event) => {
    if (
      event.name === 'project.authentication-required' ||
      event.name === 'knowledge.page-changed'
    ) {
      if (!currentProjectRuntime || !requestManualTakeover) {
        throw new Error('当前 Project Runtime 不支持人工接管请求')
      }
      const authentication =
        event.name === 'project.authentication-required'
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
      if (
        !activeItemStore ||
        !projectRuntimeStore ||
        !currentProjectRuntime
      ) {
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
        ({ runtime }) =>
          runtime.runtimeId === currentProjectRuntime?.runtimeId
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
      if (reservation.kind === 'in-progress') {
        return {
          kind: 'in-progress',
          downloadId: reservation.record.downloadId,
          canStart: pendingManagedDownloads.some(
            ({ record }) =>
              record.downloadId === reservation.record.downloadId
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
  const pauseProjectRuntime =
    async (
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
            runtime.projectId === projectId &&
            !isTerminalProjectRuntime(runtime)
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
          detail:
            `${projectName}; runtimeId=${runtimeId}; queued=true`,
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
              `manual-takeover=true${
                reason ? `; reason=${reason}` : ''
              }`,
            projectId,
            runtimeId
          })
          return readProjectWorkspace()
        }

        if (activeWorkflowEngine?.runtimeId !== runtimeId) {
          throw new Error('Project Runtime 的浏览器执行上下文不可用')
        }
        const paused = await activeWorkflowEngine.pause(
          reason,
          category
        )
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
      await pauseProjectRuntime(
        projectId,
        reason,
        category
      )
    })
      .catch((error: unknown) => {
        console.error('自动请求人工接管失败', error)
      })
      .finally(() => {
        pendingAutomaticTakeovers.delete(projectId)
      })
  }
  const resumeProjectRuntime =
    async (projectId: string): Promise<ProjectWorkspaceSnapshot> => {
      if (!projectStore || !projectRuntimeStore || !projectScheduler) {
        throw new Error('Project Runtime 依赖当前不可用')
      }
      const state = await projectRuntimeStore.read()
      const envelope = [...state.runtimes]
        .reverse()
        .find(
          ({ runtime }) =>
            runtime.projectId === projectId &&
            runtime.status === 'paused'
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
  const stopProjectRuntime =
    async (projectId: string): Promise<ProjectWorkspaceSnapshot> => {
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
            runtime.projectId === projectId &&
            runtime.status === 'queued'
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
      supervisor.setVisible(true)
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
        (profile) =>
          profile.id === envelope.projectSnapshot.profileId
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
        finalizeBackgroundProjectRuntime(
          runtime,
          envelope.projectSnapshot.name
        )
    })
    backgroundProjectRuntimes.set(
      envelope.runtime.runtimeId,
      context
    )
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
      backgroundProjectRuntimes.delete(
        envelope.runtime.runtimeId
      )
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
        ? (await projectRuntimeStore.read()).runtimes.map(
            ({ runtime }) => structuredClone(runtime)
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
        ? backgroundProjectRuntimes
            .get(visibleBackgroundRuntimeId)
            ?.getRuntime() ?? null
        : currentProjectRuntime
      return collectMonitorSnapshot(
        visibleSupervisor,
        eventCount,
        visibleRuntime,
        allSupervisors.filter(
          (current) => current !== visibleSupervisor
        ),
        projectRuntimes
      )
    })
  })

  ipcMain.handle(IPC_CHANNELS.getCapabilityPolicy, async (event) => {
    assertTrustedSender(event.sender.id)
    return readSupervisor((current) =>
      current.getCapabilityPolicySnapshot()
    )
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
          return toProfileSummaries(
            await profileStore.setActive(nextProfileId)
          )
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
        return toProfileSummaries(
          await profileStore.delete(targetProfileId)
        )
      })
    }
  )

  ipcMain.handle(IPC_CHANNELS.getProjectWorkspace, (event) => {
    assertTrustedSender(event.sender.id)
    return readProjectWorkspace()
  })

  ipcMain.handle(
    IPC_CHANNELS.installKnowledgePlanetPilot,
    (event, profileId: unknown) => {
      assertTrustedSender(event.sender.id)
      if (
        !projectStore ||
        !profileStore ||
        !strategyStore ||
        !strategyPolicyStore ||
        typeof profileId !== 'string'
      ) {
        throw new TypeError('知识星球模板安装参数无效')
      }
      return enqueueSupervisorOperation(async () => {
        await assertProjectRuntimeInactive('安装知识星球模板')
        const [profileState, projectState, strategyState] =
          await Promise.all([
            profileStore.read(),
            projectStore.read(),
            strategyStore.read()
          ])
        if (
          !profileState.profiles.some(
            (profile) => profile.id === profileId
          )
        ) {
          throw new Error(`Profile 不存在：${profileId}`)
        }
        if (
          projectState.projects.some(
            (project) => project.id === KNOWLEDGE_PLANET_PROJECT_ID
          ) ||
          strategyState.strategies.some(
            (definition) =>
              definition.manifest.id === KNOWLEDGE_PLANET_STRATEGY_ID
          )
        ) {
          throw new Error('知识星球试点模板已经安装，请直接编辑现有配置')
        }

        const strategyWorkspace =
          await applyDevelopmentStrategyConfiguration(
            await strategyStore.save(
              createKnowledgePlanetStrategyDraft()
            ),
            await strategyPolicyStore.read()
          )
        await projectStore.save(
          createKnowledgePlanetProjectDraft({
            profileId,
            outputRoot: join(
              app.getPath('downloads'),
              'AgenticBrowser',
              'knowledge-planet'
            )
          })
        )
        const selectedState = await projectStore.setActive(
          KNOWLEDGE_PLANET_PROJECT_ID
        )
        return {
          projectWorkspace:
            await buildProjectWorkspaceSnapshot(selectedState),
          strategyWorkspace
        }
      })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.saveProject,
    (event, value: unknown) => {
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
          !profileState.profiles.some(
            (profile) => profile.id === draft.profileId
          )
        ) {
          throw new Error(`Profile 不存在：${draft.profileId}`)
        }
        await projectStore.save(draft)
        return buildProjectWorkspaceSnapshot(
          await projectStore.setActive(draft.id)
        )
      })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.setActiveProject,
    (event, projectId: unknown) => {
      assertTrustedSender(event.sender.id)
      if (!projectStore || typeof projectId !== 'string') {
        throw new TypeError('Project ID 必须是字符串')
      }
      return enqueueSupervisorOperation(async () => {
        const state = await projectStore.setActive(projectId)
        showProjectSupervisor(projectId)
        return buildProjectWorkspaceSnapshot(state)
      })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.deleteProject,
    (event, projectId: unknown) => {
      assertTrustedSender(event.sender.id)
      if (!projectStore || typeof projectId !== 'string') {
        throw new TypeError('Project ID 必须是字符串')
      }
      return enqueueSupervisorOperation(async () => {
        await assertProjectRuntimeInactive('删除 Project')
        return buildProjectWorkspaceSnapshot(
          await projectStore.delete(projectId)
        )
      })
    }
  )

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
      return enqueueSupervisorOperation(() =>
        stopProjectRuntime(projectId)
      )
    }
  )

  ipcMain.handle(IPC_CHANNELS.getStartupSettings, (event) => {
    assertTrustedSender(event.sender.id)
    return getStartupSettings()
  })

  ipcMain.handle(
    IPC_CHANNELS.setOpenAtLogin,
    (event, enabled: unknown) => {
      assertTrustedSender(event.sender.id)
      if (typeof enabled !== 'boolean') {
        throw new TypeError('开机启动设置必须是布尔值')
      }
      return setOpenAtLogin(enabled)
    }
  )

  ipcMain.handle(IPC_CHANNELS.getStrategyWorkspace, (event) => {
    assertTrustedSender(event.sender.id)
    return getStrategyWorkspaceSnapshot()
  })

  ipcMain.handle(
    IPC_CHANNELS.saveStrategy,
    (event, draft: unknown) => {
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
    }
  )

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

  ipcMain.handle(
    IPC_CHANNELS.deleteStrategy,
    (event, strategyId: unknown) => {
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
    }
  )

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
      ipcMain.removeHandler(
        IPC_CHANNELS.installKnowledgePlanetPilot
      )
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

    void enqueueSupervisorOperation(() => {
      for (const runtime of backgroundProjectRuntimes.values()) {
        runtime.dispose(true)
      }
      backgroundProjectRuntimes.clear()
      supervisor.dispose(true)
    })

    if (mainWindow === window) {
      mainWindow = null
    }
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    await shellView.webContents.loadURL(rendererUrl)
  } else {
    await shellView.webContents.loadFile(join(currentDirectory, '../renderer/index.html'))
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
    }
  }
}

function toProfileSummaries(state: ProfileState): ProfileSummary[] {
  return state.profiles.map((profile) => ({
    ...profile,
    active: profile.id === state.activeProfileId
  }))
}

function cloneProjectDefinition(
  project: ProjectDefinition
): ProjectDefinition {
  return structuredClone(project)
}

function cloneStrategyDefinitions(
  definitions: StrategyDefinition[]
): StrategyDefinition[] {
  return definitions.map((definition) => ({
    ...definition,
    manifest: {
      ...definition.manifest,
      matches: [...definition.manifest.matches],
      excludes: [...definition.manifest.excludes],
      permissions: [...definition.manifest.permissions],
      networkMatches: [...definition.manifest.networkMatches],
      config: structuredClone(definition.manifest.config),
      timeouts: { ...definition.manifest.timeouts }
    }
  }))
}

function parseDownloadIntentPayload(value: unknown): {
  businessItemId: string
  attachmentId: string
  sourceUrl: string
  originalFileName: string
  mime?: string
  expectedBytes: number | null
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  const allowedKeys = new Set([
    'businessItemId',
    'attachmentId',
    'sourceUrl',
    'fileName',
    'mime',
    'expectedBytes'
  ])
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    return null
  }
  const required = [
    record.businessItemId,
    record.attachmentId,
    record.sourceUrl,
    record.fileName
  ]
  if (
    required.some(
      (item) =>
        typeof item !== 'string' ||
        item.trim().length === 0
    ) ||
    (record.mime !== undefined &&
      (typeof record.mime !== 'string' ||
        record.mime.trim().length === 0)) ||
    (record.expectedBytes !== undefined &&
      (!Number.isSafeInteger(record.expectedBytes) ||
        (record.expectedBytes as number) < 0))
  ) {
    return null
  }
  try {
    const sourceUrl = new URL(record.sourceUrl as string)
    if (sourceUrl.protocol !== 'http:' && sourceUrl.protocol !== 'https:') {
      return null
    }
    return {
      businessItemId: record.businessItemId as string,
      attachmentId: record.attachmentId as string,
      sourceUrl: sourceUrl.toString(),
      originalFileName: record.fileName as string,
      ...(typeof record.mime === 'string'
        ? { mime: record.mime }
        : {}),
      expectedBytes:
        record.expectedBytes === undefined
          ? null
          : (record.expectedBytes as number)
    }
  } catch {
    return null
  }
}

function normalizeComparableUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    return url.toString()
  } catch {
    return value
  }
}

function parseTakeoverReason(
  value: JsonValue | undefined,
  fallback: string
): string {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.reason === 'string' &&
    value.reason.trim().length > 0
  ) {
    return value.reason.trim().slice(0, 4_000)
  }
  return fallback
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isTerminalProjectRuntime(
  runtime: ProjectRuntimeSnapshot | null | undefined
): boolean {
  return (
    runtime !== null &&
    runtime !== undefined &&
    (runtime.status === 'completed' ||
      runtime.status === 'failed' ||
      runtime.status === 'cancelled')
  )
}

function createStrategySmokeDefinitions(): StrategyDefinition[] {
  return [
    {
      manifest: {
        id: 'smoke-document-start',
        name: 'Smoke Document Start',
        version: '0.1.0',
        matches: ['<all_urls>'],
        excludes: [],
        runAt: 'document-start',
        frames: 'all',
        permissions: ['dom.write', 'log'],
        networkMatches: [],
        config: {},
        timeouts: {
          startupMs: 5_000,
          heartbeatMs: 2_000
        }
      },
      source: `
globalThis.__agenticStrategyPrivate = true
document.addEventListener(
  '__agentic-phase2-inline-probe',
  () => {
    document.documentElement.dataset.agenticStrategyStart =
      document.readyState
    document.documentElement.dataset.agenticStrategyNode =
      typeof globalThis.process === 'undefined' &&
      typeof globalThis.require === 'undefined'
        ? 'isolated'
        : 'exposed'
  },
  { once: true }
)
await agenticStrategy.log('document-start installed')
`,
      enabled: true,
      updatedAt: '2026-10-15T00:00:00.000Z'
    },
    {
      manifest: {
        id: 'smoke-idle-host-api',
        name: 'Smoke Idle Host API',
        version: '0.1.0',
        matches: ['<all_urls>'],
        excludes: [],
        runAt: 'document-idle',
        frames: 'top',
        permissions: [
          'dom.read',
          'dom.write',
          'config.read',
          'log',
          'project.emit-event',
          'network.request',
          'main-world'
        ],
        networkMatches: ['<all_urls>'],
        config: { expectedMarker: 'network-ok' },
        timeouts: {
          startupMs: 5_000,
          heartbeatMs: 2_000
        }
      },
      source: `
const response = await agenticStrategy.request({
  url: new URL('/strategy-data', location.href).toString()
})
const payload = JSON.parse(response.body)
if (payload.marker !== agenticStrategy.config.expectedMarker) {
  throw new Error('Strategy config/network marker 不匹配')
}
document.documentElement.dataset.agenticStrategyNode = payload.marker
await agenticStrategy.evaluateMainWorld(
  "globalThis.__agenticStrategyMainWorld = 'allowed'; 'allowed'"
)
await agenticStrategy.emit('smoke.strategy-ready', {
  marker: payload.marker
})
`,
      enabled: true,
      updatedAt: '2026-10-15T00:00:00.000Z'
    }
  ]
}

function createStrategyFaultSmokeDefinition(): StrategyDefinition {
  return {
    manifest: {
      id: 'smoke-heartbeat-block',
      name: 'Smoke Heartbeat Block',
      version: '0.1.0',
      matches: ['<all_urls>'],
      excludes: [],
      runAt: 'document-idle',
      frames: 'top',
      permissions: ['dom.read'],
      networkMatches: [],
      config: {},
      timeouts: {
        startupMs: 5_000,
        heartbeatMs: 500
      }
    },
    source: `
globalThis.setTimeout(() => {
  while (true) {
    // 故障注入：阻塞 renderer，验证宿主心跳可强制终止。
  }
}, 250)
`,
    enabled: true,
    updatedAt: '2026-10-15T00:00:00.000Z'
  }
}

function createProjectDownloadSmokeDefinition(): StrategyDefinition {
  return {
    manifest: {
      id: 'smoke-project-download',
      name: 'Smoke Project Download',
      version: '0.1.0',
      matches: ['<all_urls>'],
      excludes: [],
      runAt: 'document-idle',
      frames: 'top',
      permissions: ['dom.write', 'project.emit-event', 'log'],
      networkMatches: [],
      config: {},
      timeouts: {
        startupMs: 5_000,
        heartbeatMs: 2_000
      }
    },
    source: `
if (!new URL(location.href).searchParams.has('project-runtime-smoke')) {
  return
}
const noise = document.createElement('div')
noise.id = 'project-noise'
document.body.append(noise)
const blockedImage = document.createElement('img')
blockedImage.src = new URL('/blocked.png', location.href).toString()
document.body.append(blockedImage)
const sourceUrl = new URL('/sample.mp3', location.href).toString()
const reservation = await agenticStrategy.emit('download.intent', {
  businessItemId: 'post-42',
  attachmentId: 'audio-7',
  sourceUrl,
  fileName: 'meeting:sample?.mp3',
  mime: 'audio/mpeg',
  expectedBytes: 4096
})
document.documentElement.dataset.agenticDownloadIntent = reservation.kind
if (reservation.kind === 'reserved') {
  const link = document.createElement('a')
  link.href = sourceUrl
  link.download = 'meeting:sample?.mp3'
  document.body.append(link)
  link.click()
  link.remove()
} else if (reservation.kind === 'duplicate') {
  await new Promise((resolve) => setTimeout(resolve, 100))
  await agenticStrategy.emit('download.completed', {
    downloadId: reservation.downloadId,
    duplicate: true
  })
}
await agenticStrategy.log('project download intent', reservation)
`,
    enabled: true,
    updatedAt: '2026-10-15T00:00:00.000Z'
  }
}

function createProjectConcurrencySmokeDefinition(): StrategyDefinition {
  return {
    manifest: {
      id: 'smoke-project-concurrency',
      name: 'Smoke Project Concurrency',
      version: '0.1.0',
      matches: ['<all_urls>'],
      excludes: [],
      runAt: 'document-idle',
      frames: 'top',
      permissions: [
        'dom.read',
        'dom.write',
        'project.emit-event',
        'log'
      ],
      networkMatches: [],
      config: {},
      timeouts: {
        startupMs: 5_000,
        heartbeatMs: 2_000
      }
    },
    source: `
const projectId = new URL(location.href).searchParams.get(
  'concurrency-project'
)
if (!projectId) {
  return
}
document.cookie =
  'agentic_runtime=' + encodeURIComponent(projectId) +
  '; Path=/; SameSite=Lax'
await agenticStrategy.emit('runtime.ready', {
  projectId,
  cookie: document.cookie,
  href: location.href
})
const sourceUrl = new URL('/sample.mp3', location.href).toString()
const reservation = await agenticStrategy.emit('download.intent', {
  businessItemId: projectId,
  attachmentId: 'audio-1',
  sourceUrl,
  fileName: projectId + '.mp3',
  mime: 'audio/mpeg',
  expectedBytes: 4096
})
if (reservation.kind === 'reserved') {
  const link = document.createElement('a')
  link.href = sourceUrl
  link.download = projectId + '.mp3'
  document.body.append(link)
  link.click()
  link.remove()
} else if (reservation.kind === 'duplicate') {
  await agenticStrategy.emit('download.completed', {
    downloadId: reservation.downloadId,
    duplicate: true
  })
}
await agenticStrategy.log('concurrency runtime ready', { projectId })
`,
    enabled: true,
    updatedAt: '2026-10-15T00:00:00.000Z'
  }
}

function createProjectTakeoverSmokeDefinition(): StrategyDefinition {
  return {
    manifest: {
      id: 'smoke-project-takeover',
      name: 'Smoke Project Takeover',
      version: '0.1.0',
      matches: ['<all_urls>'],
      excludes: [],
      runAt: 'document-idle',
      frames: 'top',
      permissions: ['dom.write', 'project.emit-event', 'log'],
      networkMatches: [],
      config: {},
      timeouts: {
        startupMs: 5_000,
        heartbeatMs: 2_000
      }
    },
    source: `
const mode = new URL(location.href).searchParams.get('takeover')
document.documentElement.dataset.agenticTakeoverStrategy = mode || 'initial'
if (mode === 'manual-complete') {
  await agenticStrategy.emit('takeover.completed', {
    href: location.href
  })
}
await agenticStrategy.log('takeover strategy ready', { mode })
`,
    enabled: true,
    updatedAt: '2026-10-15T00:00:00.000Z'
  }
}

function createStrategyWorkspaceSmokeDraft(
  version: string,
  marker: string
): StrategyDraft {
  return {
    manifest: {
      id: 'smoke-workspace-hot-reload',
      name: 'Smoke Workspace Hot Reload',
      version,
      matches: ['<all_urls>'],
      excludes: [],
      runAt: 'document-idle',
      frames: 'top',
      permissions: ['dom.write', 'log'],
      networkMatches: [],
      config: {},
      timeouts: {
        startupMs: 5_000,
        heartbeatMs: 2_000
      }
    },
    source: `
document.documentElement.dataset.agenticStrategyNode =
  ${JSON.stringify(marker)}
await agenticStrategy.log(${JSON.stringify(`workspace ${marker}`)})
`,
    enabled: true
  }
}

function collectMonitorSnapshot(
  supervisor: BrowserTabManager,
  browserEventCount: number,
  projectRuntime: ProjectRuntimeSnapshot | null = null,
  additionalSupervisors: BrowserTabManager[] = [],
  projectRuntimes: ProjectRuntimeSnapshot[] = []
): MonitorSnapshot {
  const supervisors = [supervisor, ...additionalSupervisors]
  const strategySnapshots = supervisors.map((current) =>
    current.getStrategyRuntimeSnapshot()
  )
  const strategies = {
    activeCount: strategySnapshots.reduce(
      (total, snapshot) => total + snapshot.activeCount,
      0
    ),
    quarantinedStrategyIds: [
      ...new Set(
        strategySnapshots.flatMap(
          (snapshot) => snapshot.quarantinedStrategyIds
        )
      )
    ].sort(),
    entries: strategySnapshots.flatMap((snapshot) => snapshot.entries)
  }
  const downloads = supervisors.reduce(
    (summary, current) => {
      const next = current.getDownloadSummary()
      summary.active += next.active
      summary.completed += next.completed
      summary.failed += next.failed
      summary.receivedBytes += next.receivedBytes
      return summary
    },
    {
      active: 0,
      completed: 0,
      failed: 0,
      receivedBytes: 0
    }
  )
  const processes = app.getAppMetrics().map((metric) => ({
    pid: metric.pid,
    type: metric.type,
    cpuPercent: metric.cpu.percentCPUUsage,
    workingSetBytes: metric.memory.workingSetSize * 1024
  }))

  return {
    generatedAt: new Date().toISOString(),
    browser: supervisor.getSnapshot(),
    projectRuntime,
    projectRuntimes: projectRuntimes.map((runtime) =>
      structuredClone(runtime)
    ),
    activeProjectCount: projectRuntimes.filter(
      (runtime) =>
        runtime.status !== 'queued' &&
        runtime.status !== 'paused' &&
        !isTerminalProjectRuntime(runtime)
    ).length,
    pausedProjectCount: projectRuntimes.filter(
      (runtime) => runtime.status === 'paused'
    ).length,
    queuedProjectCount: projectRuntimes.filter(
      (runtime) => runtime.status === 'queued'
    ).length,
    browserEventCount,
    activePageCount: supervisors.reduce(
      (total, current) => total + current.listTabs().length,
      0
    ),
    activeStrategyCount: strategies.activeCount,
    strategies,
    totalCpuPercent: processes.reduce(
      (total, metric) => total + metric.cpuPercent,
      0
    ),
    totalWorkingSetBytes: processes.reduce(
      (total, metric) => total + metric.workingSetBytes,
      0
    ),
    processes,
    downloads
  }
}

async function waitForStrategyRuntime(
  supervisor: BrowserTabManager,
  expectedActiveCount: number,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = supervisor.getStrategyRuntimeSnapshot()
    if (
      snapshot.activeCount === expectedActiveCount &&
      snapshot.entries.length === expectedActiveCount &&
      snapshot.entries.every((entry) => entry.status === 'running')
    ) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(
    `等待 Strategy Runtime 就绪超时：${JSON.stringify(
      supervisor.getStrategyRuntimeSnapshot()
    )}`
  )
}

function createCheckpointStore(): BrowserCheckpointStore | undefined {
  if (
    smokeTest ||
    recoverySmokeTest ||
    strategyFaultSmokeTest ||
    strategyWorkspaceSmokeTest ||
    projectDownloadSmokeTest ||
    projectConcurrencySmokeTest ||
    projectTakeoverSmokeTest ||
    knowledgePlanetPilotSmokeTest
  ) {
    return undefined
  }

  return new BrowserCheckpointStore(
    process.env.AGENTIC_CHECKPOINT_PATH ??
      join(app.getPath('userData'), 'runtime', 'browser-checkpoint.json')
  )
}

async function runStrategyFaultSmoke(
  runtime: MainWindowRuntime,
  timeoutMs = 15_000
): Promise<Record<string, unknown>> {
  const startedAt = Date.now()
  const requiredEvents: BrowserEvent['type'][] = [
    'strategy-started',
    'strategy-ready',
    'strategy-heartbeat-missed',
    'strategy-quarantined',
    'renderer-gone',
    'recreated',
    'recovery-succeeded'
  ]

  while (Date.now() - startedAt < timeoutMs) {
    const strategy = runtime.supervisor.getStrategyRuntimeSnapshot()
    const browser = runtime.supervisor.getSnapshot()
    const observed = new Set(runtime.events.map((event) => event.type))
    const passed =
      strategy.activeCount === 0 &&
      strategy.quarantinedStrategyIds.includes('smoke-heartbeat-block') &&
      browser.generation >= 2 &&
      !browser.loading &&
      browser.responsive &&
      browser.recovery.status === 'idle' &&
      requiredEvents.every((eventType) => observed.has(eventType))
    if (passed) {
      return {
        passed: true,
        elapsedMs: Date.now() - startedAt,
        browser,
        strategy,
        observedEventTypes: [...observed],
        strategyEvents: runtime.events.filter((event) =>
          event.type.startsWith('strategy-')
        )
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  return {
    passed: false,
    elapsedMs: Date.now() - startedAt,
    browser: runtime.supervisor.getSnapshot(),
    strategy: runtime.supervisor.getStrategyRuntimeSnapshot(),
    observedEventTypes: [
      ...new Set(runtime.events.map((event) => event.type))
    ],
    strategyEvents: runtime.events.filter((event) =>
      event.type.startsWith('strategy-')
    )
  }
}

async function runStrategyWorkspaceSmoke(
  runtime: MainWindowRuntime
): Promise<Record<string, unknown>> {
  const initialGeneration = runtime.supervisor.getSnapshot().generation
  const draftV1 = createStrategyWorkspaceSmokeDraft('0.1.0', 'workspace-v1')
  const draftV2 = createStrategyWorkspaceSmokeDraft('0.1.1', 'workspace-v2')

  const savedV1 = (await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.saveStrategy(${JSON.stringify(draftV1)})`
  )) as StrategyWorkspaceSnapshot
  await waitForStrategyRuntime(runtime.supervisor, 0)
  const afterSave = await captureStrategyWorkspaceStep(runtime)

  const allowed = (await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.setStrategyAllowed(${JSON.stringify(
      draftV1.manifest.id
    )}, true)`
  )) as StrategyWorkspaceSnapshot
  await waitForStrategyRuntime(runtime.supervisor, 1)
  const afterAllow = await captureStrategyWorkspaceStep(runtime)

  const savedV2 = (await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.saveStrategy(${JSON.stringify(draftV2)})`
  )) as StrategyWorkspaceSnapshot
  await waitForStrategyRuntime(runtime.supervisor, 1)
  const afterUpdate = await captureStrategyWorkspaceStep(runtime)

  const disabled = (await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.setStrategyEnabled(${JSON.stringify(
      draftV1.manifest.id
    )}, false)`
  )) as StrategyWorkspaceSnapshot
  await waitForStrategyRuntime(runtime.supervisor, 0)
  const afterDisable = await captureStrategyWorkspaceStep(runtime)

  const enabled = (await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.setStrategyEnabled(${JSON.stringify(
      draftV1.manifest.id
    )}, true)`
  )) as StrategyWorkspaceSnapshot
  await waitForStrategyRuntime(runtime.supervisor, 1)
  const afterEnable = await captureStrategyWorkspaceStep(runtime)

  const deleted = (await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.deleteStrategy(${JSON.stringify(
      draftV1.manifest.id
    )})`
  )) as StrategyWorkspaceSnapshot
  await waitForStrategyRuntime(runtime.supervisor, 0)
  const afterDelete = await captureStrategyWorkspaceStep(runtime)

  const generations = [
    initialGeneration,
    afterSave.generation,
    afterAllow.generation,
    afterUpdate.generation,
    afterDisable.generation,
    afterEnable.generation,
    afterDelete.generation
  ]
  const generationAdvancedEveryTime = generations.every(
    (generation, index) =>
      index === 0 || generation > generations[index - 1]!
  )
  const reloadedEventCount = runtime.events.filter(
    (event) => event.type === 'strategy-reloaded'
  ).length
  const passed =
    savedV1.strategies.length === 1 &&
    savedV1.developmentAllowedStrategyIds.length === 0 &&
    afterSave.activeCount === 0 &&
    afterSave.nodeMarker === null &&
    allowed.developmentAllowedStrategyIds.includes(
      draftV1.manifest.id
    ) &&
    afterAllow.activeCount === 1 &&
    afterAllow.nodeMarker === 'workspace-v1' &&
    savedV2.strategies[0]?.manifest.version === '0.1.1' &&
    afterUpdate.activeCount === 1 &&
    afterUpdate.nodeMarker === 'workspace-v2' &&
    disabled.strategies[0]?.enabled === false &&
    afterDisable.activeCount === 0 &&
    afterDisable.nodeMarker === null &&
    enabled.strategies[0]?.enabled === true &&
    afterEnable.activeCount === 1 &&
    afterEnable.nodeMarker === 'workspace-v2' &&
    deleted.strategies.length === 0 &&
    deleted.developmentAllowedStrategyIds.length === 0 &&
    afterDelete.activeCount === 0 &&
    afterDelete.nodeMarker === null &&
    generationAdvancedEveryTime &&
    reloadedEventCount >= 6

  return {
    passed,
    generationAdvancedEveryTime,
    reloadedEventCount,
    workspaces: {
      savedV1,
      allowed,
      savedV2,
      disabled,
      enabled,
      deleted
    },
    steps: {
      afterSave,
      afterAllow,
      afterUpdate,
      afterDisable,
      afterEnable,
      afterDelete
    }
  }
}

async function runProjectDownloadSmoke(
  runtime: MainWindowRuntime,
  probe: PhaseZeroProbeServer,
  _profileId: string,
  outputRoot: string
): Promise<Record<string, unknown>> {
  const projectId = 'smoke-project-download'
  const profiles = (await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.createProfile('Smoke Project Profile')`
  )) as ProfileSummary[]
  const projectProfile = profiles.find(
    (profile) => profile.name === 'Smoke Project Profile'
  )
  if (!projectProfile) {
    throw new Error('Project download smoke 未能创建 Profile')
  }
  const projectUrl = new URL(probe.topUrl)
  projectUrl.searchParams.set('project-runtime-smoke', '1')
  const projectOrigin = projectUrl.origin
  const draft: ProjectDraft = {
    id: projectId,
    name: 'Smoke Project Download',
    profileId: projectProfile.id,
    startupPages: [probe.topUrl],
    strategies: [
      { id: 'smoke-project-download', version: '0.1.0' }
    ],
    runtime: {
      mode: 'manual',
      timezone: 'Asia/Shanghai',
      priority: 10,
      maxRunMs: 15_000
    },
    workflow: {
      version: 1,
      entryNodeId: 'open-download-page',
      nodes: [
        {
          id: 'open-download-page',
          kind: 'navigate',
          url: projectUrl.toString(),
          next: 'wait-download',
          timeoutMs: 5_000,
          maxAttempts: 1,
          checkpoint: true
        },
        {
          id: 'wait-download',
          kind: 'wait-for-event',
          eventName: 'download.completed',
          next: 'finished',
          timeoutMs: 10_000,
          maxAttempts: 1,
          checkpoint: true
        },
        {
          id: 'finished',
          kind: 'complete',
          timeoutMs: 1_000,
          maxAttempts: 1,
          checkpoint: true
        }
      ]
    },
    output: {
      root: outputRoot,
      maxBytes: 10 * 1024 * 1024,
      fileNameTemplate: '{postId}-{fileName}'
    },
    capabilities: createCapabilityPolicy(),
    filter: {
      enabled: true,
      networkRules: [
        {
          id: 'block-smoke-images',
          action: 'block',
          urlPattern: `${projectOrigin}/*`,
          resourceTypes: ['image']
        }
      ],
      cssRules: [
        {
          id: 'hide-smoke-noise',
          urlPattern: `${projectOrigin}/*`,
          selectors: ['#project-noise']
        }
      ]
    },
    retry: {
      maxConsecutiveFailures: 2,
      baseBackoffMs: 250,
      maxBackoffMs: 1_000
    },
    enabled: true
  }

  await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.saveProject(${JSON.stringify(draft)})`
  )
  const firstStart = (await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.startProjectRuntime(${JSON.stringify(projectId)})`
  )) as ProjectWorkspaceSnapshot
  const firstWorkspace = await waitForProjectRuns(
    runtime,
    projectId,
    1
  )
  const downloadManager = new ProjectDownloadManager(
    join(outputRoot, 'records', 'downloads.json')
  )
  const firstDownloads = await waitForCompletedDownloads(
    downloadManager,
    1
  )

  const secondStart = (await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.startProjectRuntime(${JSON.stringify(projectId)})`
  )) as ProjectWorkspaceSnapshot
  const secondWorkspace = await waitForProjectRuns(
    runtime,
    projectId,
    2
  )
  const finalDownloadState = await downloadManager.read()
  const completed = finalDownloadState.records.filter(
    (record) => record.status === 'completed'
  )
  const record = completed[0] ?? null
  const expectedSha256 = createHash('sha256')
    .update(Buffer.alloc(4096, 0x5a))
    .digest('hex')
  const downloads = readDirectoryNames(join(outputRoot, 'downloads'))
  const temporary = readDirectoryNames(join(outputRoot, 'tmp'))
  const projectRuntimes = secondWorkspace.runtimes.filter(
    (candidate) => candidate.projectId === projectId
  )
  const activeProfiles = (await runtime.shellView.webContents.executeJavaScript(
    'window.agenticBrowser.listProfiles()'
  )) as ProfileSummary[]
  const finalStrategies = runtime.supervisor.getStrategyRuntimeSnapshot()
  const filterHits = runtime.events.filter(
    (event) => event.type === 'filter-hit'
  )
  const cssFilterEvents = runtime.events.filter(
    (event) => event.type === 'filter-css-applied'
  )
  const passed =
    firstDownloads.records.length === 1 &&
    finalDownloadState.records.length === 1 &&
    completed.length === 1 &&
    record?.size === 4096 &&
    record.sha256 === expectedSha256 &&
    record.finalPath.startsWith(join(outputRoot, 'downloads')) &&
    downloads.length === 1 &&
    temporary.length === 0 &&
    projectRuntimes.length >= 2 &&
    projectRuntimes.every(
      (candidate) =>
        candidate.status === 'completed' &&
        candidate.checkpointData.lastEvent !== undefined
    ) &&
    activeProfiles.some(
      (profile) =>
        profile.id === projectProfile.id && profile.active
    ) &&
    finalStrategies.activeCount === 0 &&
    filterHits.some((event) =>
      event.detail?.includes('block-smoke-images')
    ) &&
    cssFilterEvents.some((event) =>
      event.detail?.includes('hide-smoke-noise')
    ) &&
    runtime.events.some(
      (event) => event.type === 'download-completed'
    )

  return {
    passed,
    firstStart,
    firstWorkspace,
    secondStart,
    secondWorkspace,
    downloadState: finalDownloadState,
    downloads,
    temporary,
    activeProfiles,
    finalStrategies,
    filterHits,
    cssFilterEvents,
    expectedSha256,
    observedEventTypes: [
      ...new Set(runtime.events.map((event) => event.type))
    ]
  }
}

async function runKnowledgePlanetPilotSmoke(
  runtime: MainWindowRuntime,
  probe: PhaseZeroProbeServer,
  outputRoot: string
): Promise<Record<string, unknown>> {
  const profiles = (await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.createProfile('Knowledge Planet Pilot')`
  )) as ProfileSummary[]
  const projectProfile = profiles.find(
    (profile) => profile.name === 'Knowledge Planet Pilot'
  )
  if (!projectProfile) {
    throw new Error('知识星球试点 smoke 未能创建 Profile')
  }

  const installed =
    (await runtime.shellView.webContents.executeJavaScript(
      `window.agenticBrowser.installKnowledgePlanetPilot(${JSON.stringify(
        projectProfile.id
      )})`
    )) as KnowledgePlanetPilotInstallResult
  const fixtureOrigin = new URL(probe.knowledgePlanetFeedUrl).origin
  const strategyDraft = createKnowledgePlanetStrategyDraft({
    matches: [`${fixtureOrigin}/*`],
    includeKeywords: ['会议'],
    itemSelectors: ['.topic'],
    textSelectors: ['.content'],
    audioSelectors: ['a.audio'],
    detailLinkSelectors: ['a.detail'],
    idAttributes: ['data-topic-id'],
    maximumItems: 10
  })
  const strategyWorkspace =
    (await runtime.shellView.webContents.executeJavaScript(
      `window.agenticBrowser.saveStrategy(${JSON.stringify(
        strategyDraft
      )})`
    )) as StrategyWorkspaceSnapshot

  const createEnabledDraft = (entryUrl: string): ProjectDraft => {
    const template = createKnowledgePlanetProjectDraft({
      profileId: projectProfile.id,
      outputRoot,
      entryUrl,
      runtimeMode: 'manual'
    })
    return {
      ...template,
      runtime: {
        ...template.runtime,
        maxRunMs: 30_000
      },
      enabled: true
    }
  }
  const feedDraft = createEnabledDraft(probe.knowledgePlanetFeedUrl)
  await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.saveProject(${JSON.stringify(feedDraft)})`
  )

  await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.startProjectRuntime(${JSON.stringify(
      KNOWLEDGE_PLANET_PROJECT_ID
    )})`
  )
  const firstWorkspace = await waitForProjectRuns(
    runtime,
    KNOWLEDGE_PLANET_PROJECT_ID,
    1
  )
  const itemStore = new ProjectItemStore(
    join(outputRoot, 'records', 'items.json')
  )
  const downloadManager = new ProjectDownloadManager(
    join(outputRoot, 'records', 'downloads.json')
  )
  const firstItems = await itemStore.read()
  const firstDownloads = await waitForCompletedDownloads(
    downloadManager,
    1
  )

  await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.startProjectRuntime(${JSON.stringify(
      KNOWLEDGE_PLANET_PROJECT_ID
    )})`
  )
  const secondWorkspace = await waitForProjectRuns(
    runtime,
    KNOWLEDGE_PLANET_PROJECT_ID,
    2
  )
  const secondItems = await itemStore.read()
  const secondDownloads = await downloadManager.read()

  const loginDraft = createEnabledDraft(
    probe.knowledgePlanetLoginUrl
  )
  await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.saveProject(${JSON.stringify(loginDraft)})`
  )
  await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.startProjectRuntime(${JSON.stringify(
      KNOWLEDGE_PLANET_PROJECT_ID
    )})`
  )
  const authenticationPaused = await waitForProjectRuntimeStatus(
    runtime,
    KNOWLEDGE_PLANET_PROJECT_ID,
    'paused'
  )
  const authenticationManualSnapshot =
    (await runtime.shellView.webContents.executeJavaScript(
      `window.agenticBrowser.navigate(${JSON.stringify(
        probe.knowledgePlanetFeedUrl
      )})`
    )) as BrowserSnapshot
  await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.resumeProjectRuntime(${JSON.stringify(
      KNOWLEDGE_PLANET_PROJECT_ID
    )})`
  )
  const authenticationWorkspace = await waitForProjectRuns(
    runtime,
    KNOWLEDGE_PLANET_PROJECT_ID,
    3
  )

  const changedDraft = createEnabledDraft(
    probe.knowledgePlanetChangedFeedUrl
  )
  await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.saveProject(${JSON.stringify(changedDraft)})`
  )
  await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.startProjectRuntime(${JSON.stringify(
      KNOWLEDGE_PLANET_PROJECT_ID
    )})`
  )
  const pageChangedPaused = await waitForProjectRuntimeStatus(
    runtime,
    KNOWLEDGE_PLANET_PROJECT_ID,
    'paused'
  )
  const pageChangedManualSnapshot =
    (await runtime.shellView.webContents.executeJavaScript(
      `window.agenticBrowser.navigate(${JSON.stringify(
        probe.knowledgePlanetFeedUrl
      )})`
    )) as BrowserSnapshot
  await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.resumeProjectRuntime(${JSON.stringify(
      KNOWLEDGE_PLANET_PROJECT_ID
    )})`
  )
  const finalWorkspace = await waitForProjectRuns(
    runtime,
    KNOWLEDGE_PLANET_PROJECT_ID,
    4
  )

  const finalItems = await itemStore.read()
  const finalDownloads = await downloadManager.read()
  const downloads = readDirectoryNames(join(outputRoot, 'downloads'))
  const temporary = readDirectoryNames(join(outputRoot, 'tmp'))
  const projectRuntimes = finalWorkspace.runtimes.filter(
    (candidate) =>
      candidate.projectId === KNOWLEDGE_PLANET_PROJECT_ID
  )
  const completedDownloads = finalDownloads.records.filter(
    (record) => record.status === 'completed'
  )
  const matched = finalItems.records.find(
    (record) => record.businessItemId === 'meeting-001'
  )
  const skipped = finalItems.records.find(
    (record) => record.businessItemId === 'chat-001'
  )
  const expectedSha256 = createHash('sha256')
    .update(Buffer.alloc(4096, 0x5a))
    .digest('hex')
  const expectedSecondSha256 = createHash('sha256')
    .update(Buffer.alloc(2048, 0x33))
    .digest('hex')
  const expectedButtonSha256 = createHash('sha256')
    .update(Buffer.alloc(1024, 0x71))
    .digest('hex')
  const takeoverEvents = runtime.events.filter(
    (event) =>
      event.projectId === KNOWLEDGE_PLANET_PROJECT_ID &&
      (event.type === 'project-runtime-paused' ||
        event.type === 'project-runtime-resumed')
  )
  const passed =
    installed.projectWorkspace.projects.some(
      (project) =>
        project.id === KNOWLEDGE_PLANET_PROJECT_ID && !project.enabled
    ) &&
    installed.strategyWorkspace.strategies.some(
      (definition) =>
        definition.manifest.id === KNOWLEDGE_PLANET_STRATEGY_ID
    ) &&
    firstItems.records.length === 2 &&
    firstDownloads.records.length === 3 &&
    secondItems.records.length === 2 &&
    secondDownloads.records.length === 3 &&
    finalItems.records.length === 2 &&
    matched?.classification === 'matched' &&
    matched.attachmentCount === 3 &&
    matched.seenCount === 4 &&
    skipped?.classification === 'skipped' &&
    skipped.seenCount === 4 &&
    completedDownloads.length === 3 &&
    completedDownloads.some(
      (record) =>
        record.size === 4096 && record.sha256 === expectedSha256
    ) &&
    completedDownloads.some(
      (record) =>
        record.size === 2048 && record.sha256 === expectedSecondSha256
    ) &&
    completedDownloads.some(
      (record) =>
        record.size === 1024 && record.sha256 === expectedButtonSha256
    ) &&
    downloads.length === 3 &&
    temporary.length === 0 &&
    authenticationPaused.lastFailureCategory === 'authentication' &&
    authenticationPaused.lastError?.includes('登录失效') === true &&
    authenticationManualSnapshot.url.startsWith(
      probe.knowledgePlanetFeedUrl
    ) &&
    pageChangedPaused.lastFailureCategory === 'page-changed' &&
    pageChangedPaused.lastError?.includes('audioSelectors') === true &&
    pageChangedManualSnapshot.url.startsWith(
      probe.knowledgePlanetFeedUrl
    ) &&
    projectRuntimes.length >= 4 &&
    projectRuntimes.every(
      (candidate) =>
        candidate.status === 'completed' &&
        candidate.counters.scanned === 2 &&
        candidate.counters.matched === 1 &&
        candidate.counters.skipped === 1
    ) &&
    projectRuntimes.reduce(
      (total, candidate) => total + candidate.counters.downloaded,
      0
    ) === 3 &&
    takeoverEvents.filter(
      (event) => event.type === 'project-runtime-paused'
    ).length === 2 &&
    takeoverEvents.filter(
      (event) => event.type === 'project-runtime-resumed'
    ).length === 2

  return {
    passed,
    installed: {
      projectIds: installed.projectWorkspace.projects.map(
        (project) => project.id
      ),
      strategyIds: installed.strategyWorkspace.strategies.map(
        (definition) => definition.manifest.id
      ),
      installedProjectEnabled:
        installed.projectWorkspace.projects.find(
          (project) => project.id === KNOWLEDGE_PLANET_PROJECT_ID
        )?.enabled ?? null
    },
    strategyWorkspace: {
      strategyIds: strategyWorkspace.strategies.map(
        (definition) => definition.manifest.id
      ),
      developmentAllowedStrategyIds:
        strategyWorkspace.developmentAllowedStrategyIds
    },
    firstWorkspace,
    secondWorkspace,
    authenticationPaused,
    authenticationManualSnapshot,
    authenticationWorkspace,
    pageChangedPaused,
    pageChangedManualSnapshot,
    finalWorkspace,
    itemState: finalItems,
    downloadState: finalDownloads,
    downloads,
    temporary,
    takeoverEvents,
    expectedSha256,
    expectedSecondSha256,
    expectedButtonSha256,
    observedEventTypes: [
      ...new Set(runtime.events.map((event) => event.type))
    ]
  }
}

async function runProjectConcurrencySmoke(
  runtime: MainWindowRuntime,
  probe: PhaseZeroProbeServer,
  outputRoot: string
): Promise<Record<string, unknown>> {
  const profiles = (await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.createProfile('Concurrency A')`
  )) as ProfileSummary[]
  const withSecond = (await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.createProfile('Concurrency B')`
  )) as ProfileSummary[]
  const profileA =
    profiles.find((profile) => profile.name === 'Concurrency A') ??
    withSecond.find((profile) => profile.name === 'Concurrency A')
  const profileB = withSecond.find(
    (profile) => profile.name === 'Concurrency B'
  )
  if (!profileA || !profileB) {
    throw new Error('Project concurrency smoke 未能创建 Profile')
  }

  const projects = [
    { id: 'concurrency-alpha', profileId: profileA.id, priority: 10 },
    { id: 'concurrency-beta', profileId: profileB.id, priority: 9 },
    { id: 'concurrency-gamma', profileId: profileA.id, priority: 8 },
    { id: 'concurrency-delta', profileId: profileB.id, priority: 7 }
  ]
  for (const project of projects) {
    const url = new URL(probe.topUrl)
    url.searchParams.set('concurrency-project', project.id)
    const draft: ProjectDraft = {
      id: project.id,
      name: project.id,
      profileId: project.profileId,
      startupPages: [url.toString()],
      strategies: [
        { id: 'smoke-project-concurrency', version: '0.1.0' }
      ],
      runtime: {
        mode: 'manual',
        timezone: 'Asia/Shanghai',
        priority: project.priority,
        maxRunMs: 15_000
      },
      workflow: {
        version: 1,
        entryNodeId: 'open',
        nodes: [
          {
            id: 'open',
            kind: 'navigate',
            url: url.toString(),
            next: 'ready',
            timeoutMs: 5_000,
            maxAttempts: 1,
            checkpoint: true
          },
          {
            id: 'ready',
            kind: 'wait-for-event',
            eventName: 'runtime.ready',
            next: 'downloaded',
            timeoutMs: 5_000,
            maxAttempts: 1,
            checkpoint: true
          },
          {
            id: 'downloaded',
            kind: 'wait-for-event',
            eventName: 'download.completed',
            next: 'hold',
            timeoutMs: 10_000,
            maxAttempts: 1,
            checkpoint: true
          },
          {
            id: 'hold',
            kind: 'delay',
            delayMs: 2_500,
            next: 'finished',
            timeoutMs: 5_000,
            maxAttempts: 1,
            checkpoint: true
          },
          {
            id: 'finished',
            kind: 'complete',
            timeoutMs: 1_000,
            maxAttempts: 1,
            checkpoint: true
          }
        ]
      },
      output: {
        root: join(outputRoot, project.id),
        maxBytes: 1024 * 1024,
        fileNameTemplate: '{postId}-{fileName}'
      },
      capabilities: createCapabilityPolicy(),
      filter: {
        enabled: false,
        networkRules: [],
        cssRules: []
      },
      retry: {
        maxConsecutiveFailures: 2,
        baseBackoffMs: 250,
        maxBackoffMs: 1_000
      },
      enabled: true
    }
    await runtime.shellView.webContents.executeJavaScript(
      `window.agenticBrowser.saveProject(${JSON.stringify(draft)})`
    )
  }

  for (const project of projects) {
    await runtime.shellView.webContents.executeJavaScript(
      `window.agenticBrowser.startProjectRuntime(${JSON.stringify(project.id)})`
    )
  }

  const overlap = await waitForProjectConcurrency(runtime)
  const stoppedWorkspace =
    (await runtime.shellView.webContents.executeJavaScript(
      `window.agenticBrowser.stopProjectRuntime('concurrency-delta')`
    )) as ProjectWorkspaceSnapshot
  const stoppedRuntime = stoppedWorkspace.runtimes.find(
    (candidate) => candidate.projectId === 'concurrency-delta'
  )
  const afterQueuedStop = await waitForProjectConcurrency(
    runtime,
    15_000,
    1
  )
  const [alphaCookie, betaCookie] = await Promise.all([
    waitForProfileCookie(
      profileA.id,
      probe.topUrl,
      'concurrency-alpha'
    ),
    waitForProfileCookie(
      profileB.id,
      probe.topUrl,
      'concurrency-beta'
    )
  ])
  const completed = await waitForProjectSet(
    runtime,
    projects.map((project) => project.id)
  )
  const completedProjectIds = new Set([
    'concurrency-alpha',
    'concurrency-beta',
    'concurrency-gamma'
  ])
  const downloadStates = await Promise.all(
    projects
      .filter((project) => completedProjectIds.has(project.id))
      .map(async (project) => {
        const root = join(outputRoot, project.id)
        const manager = new ProjectDownloadManager(
          join(root, 'records', 'downloads.json')
        )
        return {
          projectId: project.id,
          root,
          state: await waitForCompletedDownloads(manager, 1),
          downloads: readDirectoryNames(join(root, 'downloads')),
          temporary: readDirectoryNames(join(root, 'tmp'))
        }
      })
  )
  const runtimes = completed.runtimes.filter((candidate) =>
    projects.some((project) => project.id === candidate.projectId)
  )
  const gammaCookie = await waitForProfileCookie(
    profileA.id,
    probe.topUrl,
    'concurrency-gamma'
  )
  const passed =
    overlap.activeProjectCount === 2 &&
    overlap.queuedProjectCount === 2 &&
    stoppedRuntime?.status === 'cancelled' &&
    afterQueuedStop.activeProjectCount === 2 &&
    afterQueuedStop.queuedProjectCount === 1 &&
    overlap.activePageCount >= 2 &&
    afterQueuedStop.activePageCount >= 2 &&
    runtimes.length === 4 &&
    runtimes.every((candidate) =>
      candidate.projectId === 'concurrency-delta'
        ? candidate.status === 'cancelled'
        : candidate.status === 'completed'
    ) &&
    alphaCookie.includes('concurrency-alpha') &&
    !alphaCookie.includes('concurrency-beta') &&
    betaCookie.includes('concurrency-beta') &&
    !betaCookie.includes('concurrency-alpha') &&
    gammaCookie.includes('concurrency-gamma') &&
    downloadStates.every((download) => {
      const records = download.state.records.filter(
        (record) => record.status === 'completed'
      )
      return (
        records.length === 1 &&
        records[0]?.projectId === download.projectId &&
        records[0].size === 4096 &&
        records[0].finalPath.startsWith(
          join(download.root, 'downloads')
        ) &&
        download.downloads.length === 1 &&
        download.temporary.length === 0
      )
    })

  return {
    passed,
    overlap,
    afterQueuedStop,
    completed,
    cookies: {
      alpha: alphaCookie,
      beta: betaCookie,
      gamma: gammaCookie
    },
    downloadStates,
    observedEventTypes: [
      ...new Set(runtime.events.map((event) => event.type))
    ]
  }
}

async function runProjectTakeoverSmoke(
  runtime: MainWindowRuntime,
  probe: PhaseZeroProbeServer,
  profileId: string,
  outputRoot: string
): Promise<Record<string, unknown>> {
  const profiles =
    (await runtime.shellView.webContents.executeJavaScript(
      `window.agenticBrowser.createProfile('Takeover Background')`
    )) as ProfileSummary[]
  const takeoverProfile = profiles.find(
    (profile) => profile.name === 'Takeover Background'
  )
  if (!takeoverProfile) {
    throw new Error('Project takeover smoke 未能创建后台 Profile')
  }
  const blockerDraft: ProjectDraft = {
    id: 'smoke-project-takeover-blocker',
    name: 'Smoke Project Takeover Blocker',
    profileId,
    startupPages: [probe.topUrl],
    strategies: [],
    runtime: {
      mode: 'manual',
      timezone: 'Asia/Shanghai',
      priority: 20,
      maxRunMs: 30_000
    },
    workflow: {
      version: 1,
      entryNodeId: 'hold',
      nodes: [
        {
          id: 'hold',
          kind: 'delay',
          delayMs: 15_000,
          next: 'finished',
          timeoutMs: 20_000,
          maxAttempts: 1,
          checkpoint: true
        },
        {
          id: 'finished',
          kind: 'complete',
          timeoutMs: 1_000,
          maxAttempts: 1,
          checkpoint: true
        }
      ]
    },
    output: {
      root: join(outputRoot, 'blocker'),
      maxBytes: 1024 * 1024,
      fileNameTemplate: '{postId}-{fileName}'
    },
    capabilities: createCapabilityPolicy(),
    filter: {
      enabled: false,
      networkRules: [],
      cssRules: []
    },
    retry: {
      maxConsecutiveFailures: 1,
      baseBackoffMs: 250,
      maxBackoffMs: 1_000
    },
    enabled: true
  }
  await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.saveProject(${JSON.stringify(blockerDraft)})`
  )

  const initialUrl = new URL(probe.topUrl)
  initialUrl.searchParams.set('takeover', 'initial')
  const manualUrl = new URL(probe.topUrl)
  manualUrl.searchParams.set('takeover', 'manual-complete')
  const draft: ProjectDraft = {
    id: 'smoke-project-takeover',
    name: 'Smoke Project Takeover',
    profileId: takeoverProfile.id,
    startupPages: [initialUrl.toString()],
    strategies: [
      { id: 'smoke-project-takeover', version: '0.1.0' }
    ],
    runtime: {
      mode: 'manual',
      timezone: 'Asia/Shanghai',
      priority: 10,
      maxRunMs: 30_000
    },
    workflow: {
      version: 1,
      entryNodeId: 'open',
      nodes: [
        {
          id: 'open',
          kind: 'navigate',
          url: initialUrl.toString(),
          next: 'human-complete',
          timeoutMs: 5_000,
          maxAttempts: 1,
          checkpoint: true
        },
        {
          id: 'human-complete',
          kind: 'wait-for-event',
          eventName: 'takeover.completed',
          next: 'finished',
          timeoutMs: 20_000,
          maxAttempts: 1,
          checkpoint: true
        },
        {
          id: 'finished',
          kind: 'complete',
          timeoutMs: 1_000,
          maxAttempts: 1,
          checkpoint: true
        }
      ]
    },
    output: {
      root: outputRoot,
      maxBytes: 1024 * 1024,
      fileNameTemplate: '{postId}-{fileName}'
    },
    capabilities: createCapabilityPolicy(),
    filter: {
      enabled: false,
      networkRules: [],
      cssRules: []
    },
    retry: {
      maxConsecutiveFailures: 2,
      baseBackoffMs: 250,
      maxBackoffMs: 1_000
    },
    enabled: true
  }
  await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.saveProject(${JSON.stringify(draft)})`
  )
  await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.startProjectRuntime(${JSON.stringify(blockerDraft.id)})`
  )
  await waitForProjectRuntimeStatus(runtime, blockerDraft.id, 'waiting')
  await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.startProjectRuntime(${JSON.stringify(draft.id)})`
  )
  const beforePause = await waitForProjectRuntimeStatus(
    runtime,
    draft.id,
    'waiting'
  )
  const beforeMonitor =
    (await runtime.shellView.webContents.executeJavaScript(
      'window.agenticBrowser.getMonitorSnapshot()'
    )) as MonitorSnapshot

  await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.pauseProjectRuntime(${JSON.stringify(draft.id)})`
  )
  const paused = await waitForProjectRuntimeStatus(
    runtime,
    draft.id,
    'paused'
  )
  const pausedMonitor =
    (await runtime.shellView.webContents.executeJavaScript(
      'window.agenticBrowser.getMonitorSnapshot()'
    )) as MonitorSnapshot
  const manualSnapshot =
    (await runtime.shellView.webContents.executeJavaScript(
      `window.agenticBrowser.navigate(${JSON.stringify(manualUrl.toString())})`
    )) as BrowserSnapshot
  await new Promise((resolve) => setTimeout(resolve, 500))
  const duringManual = await waitForProjectRuntimeStatus(
    runtime,
    draft.id,
    'paused'
  )
  const manualMonitor =
    (await runtime.shellView.webContents.executeJavaScript(
      'window.agenticBrowser.getMonitorSnapshot()'
    )) as MonitorSnapshot

  await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.resumeProjectRuntime(${JSON.stringify(draft.id)})`
  )
  const completed = await waitForProjectSet(runtime, [draft.id])
  const finalRuntime = [...completed.runtimes]
    .reverse()
    .find((candidate) => candidate.projectId === draft.id)
  const finalMonitor =
    (await runtime.shellView.webContents.executeJavaScript(
      'window.agenticBrowser.getMonitorSnapshot()'
    )) as MonitorSnapshot
  const eventTypes = runtime.events
    .filter((event) => event.projectId === draft.id)
    .map((event) => event.type)
  const passed =
    beforePause.status === 'waiting' &&
    beforeMonitor.activeProjectCount === 2 &&
    beforeMonitor.activePageCount >= 2 &&
    beforeMonitor.activeStrategyCount === 1 &&
    paused.status === 'paused' &&
    pausedMonitor.pausedProjectCount === 1 &&
    pausedMonitor.activeStrategyCount === 0 &&
    pausedMonitor.browser.generation > beforeMonitor.browser.generation &&
    manualSnapshot.url === manualUrl.toString() &&
    duringManual.status === 'paused' &&
    manualMonitor.activeStrategyCount === 0 &&
    finalRuntime?.status === 'completed' &&
    finalRuntime.checkpointData.lastEvent !== undefined &&
    finalMonitor.pausedProjectCount === 0 &&
    eventTypes.includes('project-runtime-paused') &&
    eventTypes.includes('project-runtime-resumed')

  const stoppedBlocker =
    (await runtime.shellView.webContents.executeJavaScript(
      `window.agenticBrowser.stopProjectRuntime(${JSON.stringify(blockerDraft.id)})`
    )) as ProjectWorkspaceSnapshot

  return {
    passed,
    stoppedBlocker,
    beforePause,
    beforeMonitor,
    paused,
    pausedMonitor,
    manualSnapshot,
    duringManual,
    manualMonitor,
    completed,
    finalMonitor,
    eventTypes
  }
}

async function waitForProjectConcurrency(
  runtime: MainWindowRuntime,
  timeoutMs = 15_000,
  expectedQueued = 2
): Promise<MonitorSnapshot> {
  const deadline = Date.now() + timeoutMs
  let latest: MonitorSnapshot | null = null
  while (Date.now() < deadline) {
    latest = (await runtime.shellView.webContents.executeJavaScript(
      'window.agenticBrowser.getMonitorSnapshot()'
    )) as MonitorSnapshot
    if (
      latest.activeProjectCount === 2 &&
      latest.queuedProjectCount === expectedQueued &&
      latest.activePageCount >= 2
    ) {
      return latest
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(
    `等待 Project 并发执行超时：${JSON.stringify(latest)}`
  )
}

async function waitForProjectRuntimeStatus(
  runtime: MainWindowRuntime,
  projectId: string,
  expectedStatus: ProjectRuntimeSnapshot['status'],
  timeoutMs = 15_000
): Promise<ProjectRuntimeSnapshot> {
  const deadline = Date.now() + timeoutMs
  let latest: ProjectRuntimeSnapshot | null = null
  while (Date.now() < deadline) {
    const workspace =
      (await runtime.shellView.webContents.executeJavaScript(
        'window.agenticBrowser.getProjectWorkspace()'
      )) as ProjectWorkspaceSnapshot
    latest =
      [...workspace.runtimes]
        .reverse()
        .find((candidate) => candidate.projectId === projectId) ??
      null
    if (latest?.status === expectedStatus) {
      return latest
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(
    `等待 Project Runtime 状态 ${expectedStatus} 超时：` +
      JSON.stringify(latest)
  )
}

async function waitForProjectSet(
  runtime: MainWindowRuntime,
  projectIds: string[],
  timeoutMs = 20_000
): Promise<ProjectWorkspaceSnapshot> {
  const deadline = Date.now() + timeoutMs
  let latest: ProjectWorkspaceSnapshot | null = null
  while (Date.now() < deadline) {
    latest = (await runtime.shellView.webContents.executeJavaScript(
      'window.agenticBrowser.getProjectWorkspace()'
    )) as ProjectWorkspaceSnapshot
    const selected = latest.runtimes.filter((candidate) =>
      projectIds.includes(candidate.projectId)
    )
    if (
      selected.length === projectIds.length &&
      selected.every((candidate) =>
        isTerminalProjectRuntime(candidate)
      )
    ) {
      return latest
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(
    `等待并发 Project 完成超时：${JSON.stringify(latest)}`
  )
}

async function waitForProfileCookie(
  profileId: string,
  url: string,
  expectedValue: string,
  timeoutMs = 10_000
): Promise<string> {
  const profileSession = session.fromPartition(`persist:${profileId}`)
  const deadline = Date.now() + timeoutMs
  let latest = ''
  while (Date.now() < deadline) {
    const cookies = await profileSession.cookies.get({
      url,
      name: 'agentic_runtime'
    })
    latest = cookies[0]?.value ?? ''
    if (latest === expectedValue) {
      return latest
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(
    `等待 Profile Cookie 超时：${profileId}; ` +
    `expected=${expectedValue}; actual=${latest}`
  )
}

async function waitForProjectRuns(
  runtime: MainWindowRuntime,
  projectId: string,
  minimumRuns: number,
  timeoutMs = 15_000
): Promise<ProjectWorkspaceSnapshot> {
  const deadline = Date.now() + timeoutMs
  let latest: ProjectWorkspaceSnapshot | null = null
  while (Date.now() < deadline) {
    latest = (await runtime.shellView.webContents.executeJavaScript(
      'window.agenticBrowser.getProjectWorkspace()'
    )) as ProjectWorkspaceSnapshot
    const projectRuntimes = latest.runtimes.filter(
      (candidate) => candidate.projectId === projectId
    )
    if (
      projectRuntimes.length >= minimumRuns &&
      projectRuntimes.every((candidate) =>
        isTerminalProjectRuntime(candidate)
      )
    ) {
      return latest
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(
    `等待 Project Runtime 完成超时：${JSON.stringify(latest)}`
  )
}

async function waitForCompletedDownloads(
  manager: ProjectDownloadManager,
  minimumCompleted: number,
  timeoutMs = 15_000
) {
  const deadline = Date.now() + timeoutMs
  let latest = await manager.read()
  while (Date.now() < deadline) {
    const state = await manager.read()
    latest = state
    if (
      state.records.filter((record) => record.status === 'completed')
        .length >= minimumCompleted
    ) {
      return state
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(
    `等待 Project 下载完成超时：${JSON.stringify(latest)}`
  )
}

function readDirectoryNames(path: string): string[] {
  try {
    return readdirSync(path).sort()
  } catch {
    return []
  }
}

async function captureStrategyWorkspaceStep(
  runtime: MainWindowRuntime
): Promise<{
  generation: number
  activeCount: number
  nodeMarker: string | null
}> {
  const browser = runtime.supervisor.getSnapshot()
  const strategy = runtime.supervisor.getStrategyRuntimeSnapshot()
  const topFrame = (await runtime.supervisor.collectFrameDiagnostics()).find(
    (frame) => frame.isMainFrame
  )
  return {
    generation: browser.generation,
    activeCount: strategy.activeCount,
    nodeMarker: topFrame?.currentStrategy.nodeMarker ?? null
  }
}

async function runWatchdogSmokeChild(
  runtime: MainWindowRuntime,
  restoredCheckpoint: BrowserCheckpoint | null,
  requestedUrl: string | undefined
): Promise<void> {
  const resultPath = process.env.AGENTIC_WATCHDOG_CHILD_RESULT_PATH
  if (!resultPath) {
    throw new Error('Watchdog smoke 缺少结果文件路径')
  }

  const checkpoint = await runtime.supervisor.flushCheckpoint(
    watchdogRestartCount === 0 ? 'watchdog-smoke-ready' : 'watchdog-smoke-restored'
  )
  const snapshot = runtime.supervisor.getSnapshot()
  const profileCookiePresent =
    await runtime.supervisor.hasProfileCookie('agentic_watchdog_session')
  const startupSettings = getStartupSettings()
  const expectedStartupSupport =
    app.isPackaged &&
    (process.platform === 'win32' || process.platform === 'darwin')
  const startupIntegrationPassed =
    startupSettings.supported === expectedStartupSupport &&
    startupSettings.managedByWatchdog
  const targetUrl = restoredCheckpoint?.url ?? requestedUrl
  const passed =
    watchdogRestartCount > 0 &&
    restoredCheckpoint !== null &&
    checkpoint !== null &&
    targetUrl !== undefined &&
    snapshot.url === targetUrl &&
    checkpoint.url === targetUrl &&
    profileCookiePresent &&
    startupIntegrationPassed
  const result = {
    ready: true,
    passed: watchdogRestartCount === 0 ? null : passed,
    pid: process.pid,
    restartCount: watchdogRestartCount,
    restoredFromCheckpoint: restoredCheckpoint !== null,
    restoredCheckpoint,
    checkpoint,
    snapshot,
    profileCookiePresent,
    heartbeatActive: mainProcessHeartbeat !== null,
    startupSettings,
    startupIntegrationPassed
  }

  await writeJsonAtomic(resultPath, result)
  console.log(`AGENTIC_BROWSER_WATCHDOG_CHILD ${JSON.stringify(result)}`)

  if (watchdogRestartCount > 0) {
    runtime.window.close()
    await mainProcessHeartbeat?.stop()
    app.exit(passed ? 0 : 1)
  }
}

async function runRecoverySmoke(
  runtime: MainWindowRuntime,
  probe: PhaseZeroProbeServer
): Promise<Record<string, unknown>> {
  const popupUrl = new URL('/popup', probe.topUrl).toString()
  const profileCookieName = 'agentic_profile_smoke'
  await runtime.supervisor.setProfileCookieForDiagnostics(
    profileCookieName,
    'default-profile'
  )
  const createdProfiles = (await runtime.shellView.webContents.executeJavaScript(
    "window.agenticBrowser.createProfile('Recovery Smoke Profile')"
  )) as ProfileSummary[]
  const smokeProfile = createdProfiles.find(
    (profile) => profile.name === 'Recovery Smoke Profile'
  )
  if (!smokeProfile) {
    throw new Error('恢复冒烟：未能通过 BrowserShell 创建 Profile')
  }

  await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.activateProfile(${JSON.stringify(smokeProfile.id)})`
  )
  if (await runtime.supervisor.hasProfileCookie(profileCookieName)) {
    throw new Error('恢复冒烟：新 Profile 读取到了默认 Profile Cookie')
  }

  await runtime.shellView.webContents.executeJavaScript(
    "window.agenticBrowser.activateProfile('profile-default')"
  )
  if (!(await runtime.supervisor.hasProfileCookie(profileCookieName))) {
    throw new Error('恢复冒烟：切回默认 Profile 后 Cookie 未恢复')
  }

  const remainingProfiles =
    (await runtime.shellView.webContents.executeJavaScript(
      `window.agenticBrowser.deleteProfile(${JSON.stringify(smokeProfile.id)})`
    )) as ProfileSummary[]
  if (remainingProfiles.some((profile) => profile.id === smokeProfile.id)) {
    throw new Error('恢复冒烟：非活动 Profile 删除失败')
  }
  const deletedProfileCookies = await session
    .fromPartition(`persist:${smokeProfile.id}`)
    .cookies.get({})
  if (deletedProfileCookies.length > 0) {
    throw new Error('恢复冒烟：删除 Profile 后 session Cookie 未清理')
  }
  const profileIsolationPassed = true
  const profileDeletionClearedSession = true

  const initialTabs = runtime.supervisor.listTabs()
  const tabsAfterCreate = await runtime.supervisor.createTab(popupUrl)
  const firstTab = initialTabs[0]
  const secondTab = tabsAfterCreate.find((tab) => tab.active)
  if (!firstTab || !secondTab || firstTab.id === secondTab.id) {
    throw new Error('多标签创建结果无效')
  }
  const tabsAfterOwnerClose = runtime.supervisor.closeTab(firstTab.id)
  const multiTabPassed =
    tabsAfterCreate.length === 2 &&
    tabsAfterOwnerClose.length === 1 &&
    tabsAfterOwnerClose[0]?.id === secondTab.id &&
    tabsAfterOwnerClose[0]?.active === true

  await runtime.supervisor.triggerPopup(popupUrl)
  await waitUntil(
    () => runtime.events.some((event) => event.type === 'popup-blocked'),
    2_000
  )
  const popupBlocked = runtime.events.some(
    (event) => event.type === 'popup-blocked'
  )

  const capabilityOrigin = new URL(probe.topUrl).origin
  const permissionDeniedBeforeOverride =
    (await runtime.supervisor.queryPermissionForDiagnostics('geolocation')) ===
    'denied'
  const allowOriginPolicy = {
    ...runtime.supervisor.getCapabilityPolicy(),
    origins: [
      {
        origin: capabilityOrigin,
        overrides: {
          popups: true,
          geolocation: true
        }
      }
    ]
  }
  await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.setCapabilityPolicy(${JSON.stringify(
      allowOriginPolicy
    )})`
  )
  const permissionAllowedByOrigin =
    (await runtime.supervisor.queryPermissionForDiagnostics('geolocation')) ===
    'granted'
  await runtime.supervisor.triggerPopup(popupUrl)
  await waitUntil(
    () => runtime.supervisor.getSnapshot().url === popupUrl,
    3_000
  )
  const popupRouted =
    runtime.supervisor.getSnapshot().url === popupUrl &&
    runtime.events.some((event) => event.type === 'popup-routed')

  const downloadUrl = new URL('/sample.mp3', probe.topUrl).toString()
  runtime.supervisor.requestDownload(downloadUrl)
  await waitUntil(
    () => runtime.supervisor.getDownloadSummary().completed === 1,
    5_000
  )
  const allowedDownload = runtime.supervisor.getDownloadSummary()
  const denyOriginPolicy = {
    ...runtime.supervisor.getCapabilityPolicy(),
    origins: [
      {
        origin: capabilityOrigin,
        overrides: {
          popups: true,
          geolocation: false,
          downloads: false
        }
      }
    ]
  }
  await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.setCapabilityPolicy(${JSON.stringify(
      denyOriginPolicy
    )})`
  )
  const permissionDeniedByOrigin =
    (await runtime.supervisor.queryPermissionForDiagnostics('geolocation')) ===
    'denied'
  runtime.supervisor.requestDownload(`${downloadUrl}?blocked=1`)
  await waitUntil(
    () => runtime.events.some((event) => event.type === 'download-blocked'),
    3_000
  )
  const downloadBlocked = runtime.events.some(
    (event) => event.type === 'download-blocked'
  )
  const capabilityOriginPolicyPassed =
    permissionDeniedBeforeOverride &&
    permissionAllowedByOrigin &&
    permissionDeniedByOrigin &&
    runtime.supervisor.getCapabilityPolicySnapshot().currentOrigin ===
      capabilityOrigin &&
    runtime.supervisor.getCapabilityPolicySnapshot().effective.popups &&
    !runtime.supervisor.getCapabilityPolicySnapshot().effective.downloads
  const tabsWithTemporaryPermissionOwner =
    await runtime.supervisor.createTab(popupUrl)
  const temporaryPermissionOwner = tabsWithTemporaryPermissionOwner.find(
    (tab) => tab.active
  )
  if (!temporaryPermissionOwner) {
    throw new Error('恢复冒烟：无法创建 permission handler 临时所有者')
  }
  const tabsAfterPermissionOwnerClose = runtime.supervisor.closeTab(
    temporaryPermissionOwner.id
  )
  const eventSequenceAfterPermissionOwnerClose =
    runtime.events.at(-1)?.sequence ?? 0
  await new Promise((resolve) => setTimeout(resolve, 750))
  const closedTabStoppedPublishing = !runtime.events.some(
    (event) =>
      event.tabId === temporaryPermissionOwner.id &&
      event.sequence > eventSequenceAfterPermissionOwnerClose
  )
  const permissionHandlerTransferPassed =
    tabsAfterPermissionOwnerClose.length === 1 &&
    closedTabStoppedPublishing &&
    (await runtime.supervisor.queryPermissionForDiagnostics('geolocation')) ===
      'denied'

  let navigationRejected = false
  const failedUrl = new URL('/disconnect', probe.topUrl).toString()
  try {
    await runtime.supervisor.navigate(failedUrl)
  } catch {
    navigationRejected = true
  }

  const startedAt = Date.now()
  while (
    runtime.supervisor.getSnapshot().recovery.status !== 'circuit-open' &&
    Date.now() - startedAt < 10_000
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  const snapshot = runtime.supervisor.getSnapshot()
  const recoveryActions = runtime.events
    .filter((event) => event.type === 'recovery-started')
    .map((event) => event.detail?.split(';')[0] ?? '')
  const expectedActions = [
    'reload',
    'reload-ignore-cache',
    'clear-cache-and-reload',
    'recreate-view'
  ]
  const passed =
    profileIsolationPassed &&
    profileDeletionClearedSession &&
    multiTabPassed &&
    capabilityOriginPolicyPassed &&
    permissionHandlerTransferPassed &&
    popupBlocked &&
    popupRouted &&
    allowedDownload.completed === 1 &&
    allowedDownload.receivedBytes === 4096 &&
    downloadBlocked &&
    navigationRejected &&
    snapshot.recovery.status === 'circuit-open' &&
    snapshot.recovery.attemptsInWindow === 4 &&
    snapshot.responsive === false &&
    snapshot.generation >= 2 &&
    expectedActions.every(
      (action, index) => recoveryActions[index] === action
    ) &&
    runtime.events.some((event) => event.type === 'circuit-open')

  return {
    passed,
    navigationRejected,
    profileIsolationPassed,
    profileDeletionClearedSession,
    capabilityOriginPolicyPassed,
    permissionDeniedBeforeOverride,
    permissionAllowedByOrigin,
    permissionDeniedByOrigin,
    permissionHandlerTransferPassed,
    closedTabStoppedPublishing,
    multiTabPassed,
    tabsAfterCreate,
    tabsAfterOwnerClose,
    popupBlocked,
    popupRouted,
    allowedDownload,
    downloadBlocked,
    failedUrl,
    elapsedMs: Date.now() - startedAt,
    recoveryActions,
    snapshot,
    events: runtime.events
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number
): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`等待条件超过 ${timeoutMs} ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function parseNonNegativeInteger(value: string | undefined): number {
  if (!value) {
    return 0
  }

  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
}

function cleanupAutomatedDownloads(): void {
  if (automatedDownloadDirectory) {
    rmSync(automatedDownloadDirectory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100
    })
    automatedDownloadDirectory = null
  }
}

async function closeSmokeRuntime(runtime: MainWindowRuntime): Promise<void> {
  runtime.suppressShellEvents()
  await Promise.all([
    runtime.supervisor.prepareForShutdown(),
    new Promise((resolve) => setTimeout(resolve, 250))
  ])
  runtime.window.close()
  await new Promise((resolve) => setTimeout(resolve, 250))
}

if (runApplication) {
  mainProcessHeartbeat?.start()
  void app.whenReady().then(async () => {
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
    knowledgePlanetPilotSmokeTest
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
    knowledgePlanetPilotSmokeTest
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
    knowledgePlanetPilotSmokeTest
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
    projectTakeoverSmokeTest ||
    knowledgePlanetPilotSmokeTest
      ? await startPhaseZeroProbeServer()
      : null
  const watchdogSmokeUrl = process.env.AGENTIC_WATCHDOG_SMOKE_URL
  if (watchdogSmokeChild && !watchdogSmokeUrl && !compatibleCheckpoint) {
    throw new Error('Watchdog smoke 缺少初始 URL')
  }

  const initialUrl =
    phaseZeroProbe?.topUrl ?? compatibleCheckpoint?.url ?? watchdogSmokeUrl
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
      !recoverySmokeTest &&
      !strategyFaultSmokeTest &&
      !strategyWorkspaceSmokeTest &&
      !projectDownloadSmokeTest &&
      !projectConcurrencySmokeTest &&
      !projectTakeoverSmokeTest &&
      !knowledgePlanetPilotSmokeTest,
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
    const beforeCrash = await runtime.supervisor.collectDiagnostics(runtime.shellView.webContents.id)
    const framesBeforeCrash = await runtime.supervisor.collectFrameDiagnostics()
    const strategiesBeforeCrash =
      runtime.supervisor.getStrategyRuntimeSnapshot()
    const profileCookieBeforeCrash =
      await runtime.supervisor.hasProfileCookie('agentic_phase0_session')
    const capture = await runtime.supervisor.benchmarkCapture()
    const interactionDuringCapture =
      await runtime.supervisor.benchmarkInteractionDuringCapture()
    const multiViewCapture = await runtime.supervisor.benchmarkMultiViewCapture()
    const heartbeatStall = await runtime.supervisor.probeHeartbeatStall()
    await runtime.supervisor.forceCrashAndWait()
    await waitForStrategyRuntime(runtime.supervisor, 4)
    const afterCrash = await runtime.supervisor.collectDiagnostics(runtime.shellView.webContents.id)
    const framesAfterCrash = await runtime.supervisor.collectFrameDiagnostics()
    const strategiesAfterCrash =
      runtime.supervisor.getStrategyRuntimeSnapshot()
    const profileCookieAfterCrash =
      await runtime.supervisor.hasProfileCookie('agentic_phase0_session')
    let failedNavigationRejected = false
    try {
      await runtime.supervisor.navigate(new URL('/disconnect', phaseZeroProbe.topUrl).toString())
    } catch {
      failedNavigationRejected = true
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
    const mainProcessId = framesBeforeCrash.find((frame) => frame.isMainFrame)?.processId
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
    const observedEventTypes = new Set(runtime.events.map((event) => event.type))
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
      expectedEventTypes.every((eventType) => observedEventTypes.has(eventType)) &&
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
    writeSmokeResult(result)
    console.log(`AGENTIC_BROWSER_SMOKE ${JSON.stringify(result)}`)

    runtime.window.close()
    await phaseZeroProbe?.close()
    phaseZeroProbe = null
    cleanupAutomatedDownloads()
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
    writeProjectConcurrencySmokeResult(result)
    console.log(
      `AGENTIC_BROWSER_PROJECT_CONCURRENCY_SMOKE ${JSON.stringify(result)}`
    )
    await closeSmokeRuntime(runtime)
    await phaseZeroProbe.close()
    phaseZeroProbe = null
    cleanupAutomatedDownloads()
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
    writeProjectTakeoverSmokeResult(result)
    console.log(
      `AGENTIC_BROWSER_PROJECT_TAKEOVER_SMOKE ${JSON.stringify(result)}`
    )
    await closeSmokeRuntime(runtime)
    await phaseZeroProbe.close()
    phaseZeroProbe = null
    cleanupAutomatedDownloads()
    app.exit(result.passed === true ? 0 : 1)
    return
  }

  if (knowledgePlanetPilotSmokeTest) {
    if (!phaseZeroProbe || !automatedDownloadDirectory) {
      throw new Error('知识星球试点 smoke 环境未初始化')
    }
    const result = await runKnowledgePlanetPilotSmoke(
      runtime,
      phaseZeroProbe,
      join(automatedDownloadDirectory, 'knowledge-planet-output')
    )
    writeKnowledgePlanetPilotSmokeResult(result)
    console.log(
      `AGENTIC_BROWSER_KNOWLEDGE_PLANET_PILOT_SMOKE ${JSON.stringify(
        result
      )}`
    )
    await closeSmokeRuntime(runtime)
    await phaseZeroProbe.close()
    phaseZeroProbe = null
    cleanupAutomatedDownloads()
    app.exit(result.passed === true ? 0 : 1)
    return
  }

  if (recoverySmokeTest) {
    if (!phaseZeroProbe) {
      throw new Error('Recovery smoke probe server 未启动')
    }
    const result = await runRecoverySmoke(runtime, phaseZeroProbe)
    writeRecoverySmokeResult(result)
    console.log(`AGENTIC_BROWSER_RECOVERY_SMOKE ${JSON.stringify(result)}`)
    runtime.window.close()
    await phaseZeroProbe.close()
    phaseZeroProbe = null
    cleanupAutomatedDownloads()
    app.exit(result.passed === true ? 0 : 1)
    return
  }

  if (strategyFaultSmokeTest) {
    if (!phaseZeroProbe) {
      throw new Error('Strategy fault smoke probe server 未启动')
    }
    const result = await runStrategyFaultSmoke(runtime)
    writeStrategyFaultSmokeResult(result)
    console.log(
      `AGENTIC_BROWSER_STRATEGY_FAULT_SMOKE ${JSON.stringify(result)}`
    )
    await closeSmokeRuntime(runtime)
    await phaseZeroProbe.close()
    phaseZeroProbe = null
    cleanupAutomatedDownloads()
    app.exit(result.passed === true ? 0 : 1)
    return
  }

  if (strategyWorkspaceSmokeTest) {
    if (!phaseZeroProbe) {
      throw new Error('Strategy workspace smoke probe server 未启动')
    }
    const result = await runStrategyWorkspaceSmoke(runtime)
    writeStrategyWorkspaceSmokeResult(result)
    console.log(
      `AGENTIC_BROWSER_STRATEGY_WORKSPACE_SMOKE ${JSON.stringify(result)}`
    )
    await closeSmokeRuntime(runtime)
    await phaseZeroProbe.close()
    phaseZeroProbe = null
    cleanupAutomatedDownloads()
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
    writeProjectDownloadSmokeResult(result)
    console.log(
      `AGENTIC_BROWSER_PROJECT_DOWNLOAD_SMOKE ${JSON.stringify(result)}`
    )
    await closeSmokeRuntime(runtime)
    await phaseZeroProbe.close()
    phaseZeroProbe = null
    cleanupAutomatedDownloads()
    app.exit(result.passed === true ? 0 : 1)
    return
  }

  if (watchdogSmokeChild) {
    await runWatchdogSmokeChild(runtime, restoredCheckpoint, watchdogSmokeUrl)
    return
  }

  app.on('activate', () => {
    if (!mainWindow) {
      void createMainWindow()
    }
  })
  }).catch((error: unknown) => {
    const result = {
      passed: false,
      error: error instanceof Error ? error.stack ?? error.message : String(error)
    }
    writeSmokeResult(result)
    writeRecoverySmokeResult(result)
    writeStrategyFaultSmokeResult(result)
    writeStrategyWorkspaceSmokeResult(result)
    writeProjectDownloadSmokeResult(result)
    writeProjectConcurrencySmokeResult(result)
    writeProjectTakeoverSmokeResult(result)
    writeKnowledgePlanetPilotSmokeResult(result)
    void phaseZeroProbe?.close()
    phaseZeroProbe = null
    cleanupAutomatedDownloads()
    void mainProcessHeartbeat?.stop()
    console.error(error)
    app.exit(1)
  })
}

app.on('before-quit', () => {
  void mainProcessHeartbeat?.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
