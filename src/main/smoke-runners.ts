import { createHash } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync
} from 'node:fs'
import { basename, join } from 'node:path'

import { app, session } from 'electron'

import type {
  AutomationPlaygroundInstallResult,
  BrowserEvent,
  BrowserSnapshot,
  MonitorSnapshot,
  ProfileSummary,
  ProjectDraft,
  ProjectRuntimeSnapshot,
  ProjectWorkspaceSnapshot,
  StrategyWorkspaceSnapshot,
  WorkflowFailureCategory
} from '../shared/contracts'
import {
  AUTOMATION_PLAYGROUND_DOWNLOAD_FILE_URL,
  AUTOMATION_PLAYGROUND_FORM_URL,
  AUTOMATION_PLAYGROUND_MISSING_URL,
  AUTOMATION_PLAYGROUND_PROJECT_ID,
  AUTOMATION_PLAYGROUND_SECOND_SITE_URL,
  AUTOMATION_PLAYGROUND_STRATEGY_ID,
  createAutomationPlaygroundProjectDraft
} from './automation-playground-pilot'
import { isTerminalProjectRuntime } from './main-helpers'
import { ProjectDownloadManager } from './project-download-manager'
import {
  PROJECT_DOWNLOAD_DISK_PROJECT_ID,
  PROJECT_DOWNLOAD_NETWORK_PROJECT_ID,
  createProjectDownloadFaultProjectDraft,
  createProjectDownloadFaultStrategyDraft
} from './project-download-fault-smoke'
import {
  PROJECT_DOWNLOAD_RECOVERY_PROJECT_ID,
  createProjectDownloadRecoveryProjectDraft,
  createProjectDownloadRecoveryStrategyDraft
} from './project-download-recovery-smoke'
import { ProjectItemStore } from './project-item-store'
import type { ProjectRuntimeStore } from './project-runtime-store'
import type { PhaseZeroProbeServer } from './phase0-probe-server'
import { createStrategyWorkspaceSmokeDraft } from './smoke-fixtures'
import { writeFileSync } from 'node:fs'

import { writeJsonAtomic } from './atomic-file'
import { type BrowserTabManager } from './browser-tab-manager'
import { createCapabilityPolicy } from './capability-store'
import { BrowserCheckpointStore } from './checkpoint-store'
import {
  automationPlaygroundSmokeTest,
  projectConcurrencySmokeTest,
  projectDownloadFaultSmokeChild,
  projectDownloadRendererRecoverySmokeChild,
  projectDownloadSmokeTest,
  projectTakeoverSmokeTest,
  recoverySmokeTest,
  smokeTest,
  strategyFaultSmokeTest,
  strategyWorkspaceSmokeTest
} from './smoke-flags'
import {
  closeSmokeRuntime,
  getMainProcessHeartbeat,
  getStartupSettings,
  parsePositiveInteger,
  requireEnvironmentValue,
  waitUntil,
  watchdogRestartCount,
  type MainWindowRuntime
} from './smoke-runtime'
import type { BrowserCheckpoint } from './checkpoint-store'

/**
 * 冒烟测试的宿主实现。
 *
 * 每个 `run*` 函数驱动一个端到端场景（策略注入、下载事务、并发调度、
 * 人工接管、watchdog 重启、崩溃恢复等），产出结构化结果供 CI 与验证文档使用。
 * 这些代码只在 `--*-smoke-test` 入口下执行，不属于正常启动路径，因此与
 * 主进程入口分离。
 */

export async function runProjectDownloadSmoke(
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
    strategies: [{ id: 'smoke-project-download', version: '0.1.0' }],
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
  const firstWorkspace = await waitForProjectRuns(runtime, projectId, 1)
  const downloadManager = new ProjectDownloadManager(
    join(outputRoot, 'records', 'downloads.json')
  )
  const firstDownloads = await waitForCompletedDownloads(downloadManager, 1)

  const secondStart = (await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.startProjectRuntime(${JSON.stringify(projectId)})`
  )) as ProjectWorkspaceSnapshot
  const secondWorkspace = await waitForProjectRuns(runtime, projectId, 2)
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
      (profile) => profile.id === projectProfile.id && profile.active
    ) &&
    finalStrategies.activeCount === 0 &&
    filterHits.some((event) => event.detail?.includes('block-smoke-images')) &&
    cssFilterEvents.some((event) =>
      event.detail?.includes('hide-smoke-noise')
    ) &&
    runtime.events.some((event) => event.type === 'download-completed')

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
    observedEventTypes: [...new Set(runtime.events.map((event) => event.type))]
  }
}

export async function runProjectDownloadRecoverySmokeChild(
  runtime: MainWindowRuntime,
  projectRuntimeStore: ProjectRuntimeStore
): Promise<void> {
  const resultPath = requireEnvironmentValue(
    'AGENTIC_PROJECT_DOWNLOAD_RECOVERY_RESULT_PATH'
  )
  const pageUrl = requireEnvironmentValue(
    'AGENTIC_PROJECT_DOWNLOAD_RECOVERY_URL'
  )
  const outputRoot = requireEnvironmentValue(
    'AGENTIC_PROJECT_DOWNLOAD_RECOVERY_OUTPUT_ROOT'
  )
  const expectedSha256 = requireEnvironmentValue(
    'AGENTIC_PROJECT_DOWNLOAD_RECOVERY_EXPECTED_SHA256'
  )
  const expectedBytes = parsePositiveInteger(
    requireEnvironmentValue('AGENTIC_PROJECT_DOWNLOAD_RECOVERY_EXPECTED_BYTES'),
    'AGENTIC_PROJECT_DOWNLOAD_RECOVERY_EXPECTED_BYTES'
  )
  const downloadManager = new ProjectDownloadManager(
    join(outputRoot, 'records', 'downloads.json')
  )

  if (watchdogRestartCount === 0) {
    const profiles = (await runtime.shellView.webContents.executeJavaScript(
      `window.agenticBrowser.createProfile('Smoke Download Recovery Profile')`
    )) as ProfileSummary[]
    const projectProfile = profiles.find(
      (profile) => profile.name === 'Smoke Download Recovery Profile'
    )
    if (!projectProfile) {
      throw new Error('下载恢复 smoke 未能创建 Profile')
    }

    const strategyDraft = createProjectDownloadRecoveryStrategyDraft(
      pageUrl,
      expectedBytes
    )
    const projectDraft = createProjectDownloadRecoveryProjectDraft({
      profileId: projectProfile.id,
      pageUrl,
      outputRoot,
      expectedBytes
    })
    await runtime.shellView.webContents.executeJavaScript(
      `window.agenticBrowser.saveStrategy(${JSON.stringify(strategyDraft)})`
    )
    await runtime.shellView.webContents.executeJavaScript(
      `window.agenticBrowser.saveProject(${JSON.stringify(projectDraft)})`
    )
    const started = (await runtime.shellView.webContents.executeJavaScript(
      `window.agenticBrowser.startProjectRuntime(${JSON.stringify(
        PROJECT_DOWNLOAD_RECOVERY_PROJECT_ID
      )})`
    )) as ProjectWorkspaceSnapshot
    const interrupted = await waitForPartialProjectDownload(
      downloadManager,
      expectedBytes,
      30_000
    )
    const runtimeState = await projectRuntimeStore.read()
    const activeRuntime = runtimeState.runtimes.find(
      ({ runtime: candidate }) =>
        candidate.projectId === PROJECT_DOWNLOAD_RECOVERY_PROJECT_ID &&
        !isTerminalProjectRuntime(candidate)
    )?.runtime
    if (!activeRuntime) {
      throw new Error('下载恢复 smoke 在强杀前没有活动 Runtime')
    }

    const result = {
      ready: true,
      stage: 'kill-ready',
      passed: null,
      pid: process.pid,
      restartCount: watchdogRestartCount,
      projectId: PROJECT_DOWNLOAD_RECOVERY_PROJECT_ID,
      runtime: activeRuntime,
      interrupted,
      started,
      expectedBytes,
      expectedSha256
    }
    await writeJsonAtomic(resultPath, result)
    console.log(
      `AGENTIC_BROWSER_PROJECT_DOWNLOAD_RECOVERY_CHILD ${JSON.stringify(
        result
      )}`
    )
    return
  }

  const recovered = await waitForRecoveredProjectDownload(
    downloadManager,
    projectRuntimeStore,
    expectedBytes,
    60_000
  )
  const failed = recovered.downloadState.records.filter(
    (record) => record.status === 'failed'
  )
  const completed = recovered.downloadState.records.filter(
    (record) => record.status === 'completed'
  )
  const interruptedRecord = failed[0] ?? null
  const completedRecord = completed[0] ?? null
  const downloads = readDirectoryNames(join(outputRoot, 'downloads'))
  const temporary = readDirectoryNames(join(outputRoot, 'tmp'))
  const interruptedSize = interruptedRecord
    ? readFileSize(interruptedRecord.temporaryPath)
    : -1
  const passed =
    watchdogRestartCount === 1 &&
    failed.length === 1 &&
    completed.length === 1 &&
    interruptedRecord?.errorCategory === 'unknown' &&
    interruptedRecord.error?.includes('应用退出时下载未完成') === true &&
    interruptedSize > 0 &&
    interruptedSize < expectedBytes &&
    completedRecord?.size === expectedBytes &&
    completedRecord.sha256 === expectedSha256 &&
    completedRecord.retryCount === 1 &&
    completedRecord.idempotencyKey === interruptedRecord.idempotencyKey &&
    completedRecord.finalPath === interruptedRecord.finalPath &&
    completedRecord.safeFileName === interruptedRecord.safeFileName &&
    downloads.length === 1 &&
    downloads[0] === basename(completedRecord.finalPath) &&
    temporary.length === 1 &&
    temporary[0] === basename(interruptedRecord.temporaryPath) &&
    recovered.runtime.status === 'completed' &&
    recovered.runtime.trigger === 'resume' &&
    recovered.runtime.counters.downloaded === 1 &&
    recovered.runtime.counters.failed === 1 &&
    recovered.runtime.counters.downloadedBytes === expectedBytes

  const result = {
    ready: true,
    stage: 'completed',
    passed,
    pid: process.pid,
    restartCount: watchdogRestartCount,
    projectId: PROJECT_DOWNLOAD_RECOVERY_PROJECT_ID,
    runtime: recovered.runtime,
    downloadState: recovered.downloadState,
    downloads,
    temporary,
    interruptedSize,
    expectedBytes,
    expectedSha256
  }
  await writeJsonAtomic(resultPath, result)
  console.log(
    `AGENTIC_BROWSER_PROJECT_DOWNLOAD_RECOVERY_CHILD ${JSON.stringify(result)}`
  )
  await closeSmokeRuntime(runtime)
  await getMainProcessHeartbeat()?.stop()
  app.exit(passed ? 0 : 1)
}

export async function waitForPartialProjectDownload(
  manager: ProjectDownloadManager,
  expectedBytes: number,
  timeoutMs: number
): Promise<{
  downloadId: string
  temporaryPath: string
  receivedBytes: number
}> {
  const deadline = Date.now() + timeoutMs
  let latest = await manager.read()
  while (Date.now() < deadline) {
    latest = await manager.read()
    const record = latest.records.find(
      (candidate) => candidate.status === 'downloading'
    )
    if (record) {
      const receivedBytes = readFileSize(record.temporaryPath)
      if (receivedBytes > 0 && receivedBytes < expectedBytes) {
        return {
          downloadId: record.downloadId,
          temporaryPath: record.temporaryPath,
          receivedBytes
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`等待下载进入部分写入状态超时：${JSON.stringify(latest)}`)
}

export async function waitForRecoveredProjectDownload(
  manager: ProjectDownloadManager,
  runtimeStore: ProjectRuntimeStore,
  expectedBytes: number,
  timeoutMs: number
) {
  const deadline = Date.now() + timeoutMs
  let latestDownloads = await manager.read()
  let latestRuntime: ProjectRuntimeSnapshot | null = null
  while (Date.now() < deadline) {
    const [downloadState, runtimeState] = await Promise.all([
      manager.read(),
      runtimeStore.read()
    ])
    latestDownloads = downloadState
    latestRuntime =
      runtimeState.runtimes.find(
        ({ runtime }) =>
          runtime.projectId === PROJECT_DOWNLOAD_RECOVERY_PROJECT_ID
      )?.runtime ?? null
    const hasInterrupted = downloadState.records.some(
      (record) =>
        record.status === 'failed' && record.errorCategory === 'unknown'
    )
    const hasCompleted = downloadState.records.some(
      (record) => record.status === 'completed' && record.size === expectedBytes
    )
    if (
      hasInterrupted &&
      hasCompleted &&
      latestRuntime?.status === 'completed'
    ) {
      return {
        downloadState,
        runtime: latestRuntime
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(
    '等待强杀后的 Project 下载恢复超时：' +
      JSON.stringify({
        downloadState: latestDownloads,
        runtime: latestRuntime
      })
  )
}

export function readFileSize(path: string): number {
  try {
    return existsSync(path) ? statSync(path).size : -1
  } catch {
    return -1
  }
}

export function writeProjectDownloadFaultSmokeChildResult(
  result: unknown
): void {
  const resultPath = process.env.AGENTIC_PROJECT_DOWNLOAD_FAULT_RESULT_PATH
  if (projectDownloadFaultSmokeChild && resultPath) {
    writeFileSync(
      resultPath,
      `${JSON.stringify(result, null, 2)}
`,
      'utf8'
    )
  }
}

export function writeProjectDownloadRendererSmokeChildResult(
  result: unknown
): void {
  const resultPath = process.env.AGENTIC_PROJECT_DOWNLOAD_RENDERER_RESULT_PATH
  if (projectDownloadRendererRecoverySmokeChild && resultPath) {
    writeFileSync(
      resultPath,
      `${JSON.stringify(result, null, 2)}
`,
      'utf8'
    )
  }
}

export async function runProjectDownloadFaultSmokeChild(
  runtime: MainWindowRuntime,
  projectRuntimeStore: ProjectRuntimeStore,
  profileId: string
): Promise<void> {
  const networkPageUrl = requireEnvironmentValue(
    'AGENTIC_PROJECT_DOWNLOAD_FAULT_NETWORK_URL'
  )
  const diskPageUrl = requireEnvironmentValue(
    'AGENTIC_PROJECT_DOWNLOAD_FAULT_DISK_URL'
  )
  const outputRoot = requireEnvironmentValue(
    'AGENTIC_PROJECT_DOWNLOAD_FAULT_OUTPUT_ROOT'
  )
  const networkBytes = parsePositiveInteger(
    requireEnvironmentValue('AGENTIC_PROJECT_DOWNLOAD_FAULT_NETWORK_BYTES'),
    'AGENTIC_PROJECT_DOWNLOAD_FAULT_NETWORK_BYTES'
  )
  const diskBytes = parsePositiveInteger(
    requireEnvironmentValue('AGENTIC_PROJECT_DOWNLOAD_FAULT_DISK_BYTES'),
    'AGENTIC_PROJECT_DOWNLOAD_FAULT_DISK_BYTES'
  )
  const networkOutputRoot = join(outputRoot, 'network')
  const diskOutputRoot = join(outputRoot, 'disk')
  const networkManager = new ProjectDownloadManager(
    join(networkOutputRoot, 'records', 'downloads.json')
  )
  const diskManager = new ProjectDownloadManager(
    join(diskOutputRoot, 'records', 'downloads.json')
  )
  const networkStrategy = createProjectDownloadFaultStrategyDraft(
    'network',
    networkPageUrl,
    networkBytes
  )
  const diskStrategy = createProjectDownloadFaultStrategyDraft(
    'disk',
    diskPageUrl,
    diskBytes
  )
  const networkProject = createProjectDownloadFaultProjectDraft('network', {
    profileId,
    pageUrl: networkPageUrl,
    outputRoot: networkOutputRoot,
    expectedBytes: networkBytes
  })
  const diskProject = createProjectDownloadFaultProjectDraft('disk', {
    profileId,
    pageUrl: diskPageUrl,
    outputRoot: diskOutputRoot,
    expectedBytes: diskBytes
  })

  for (const strategy of [networkStrategy, diskStrategy]) {
    await runtime.shellView.webContents.executeJavaScript(
      `window.agenticBrowser.saveStrategy(${JSON.stringify(strategy)})`
    )
  }
  for (const project of [networkProject, diskProject]) {
    await runtime.shellView.webContents.executeJavaScript(
      `window.agenticBrowser.saveProject(${JSON.stringify(project)})`
    )
  }

  runtime.supervisor.armManagedDownloadNetworkDropForDiagnostics(32 * 1024)
  let networkWorkspace: ProjectWorkspaceSnapshot
  let networkDiagnostics
  let networkSummary
  try {
    await runtime.shellView.webContents.executeJavaScript(
      `window.agenticBrowser.startProjectRuntime(${JSON.stringify(
        PROJECT_DOWNLOAD_NETWORK_PROJECT_ID
      )})`
    )
    networkWorkspace = await waitForProjectRuns(
      runtime,
      PROJECT_DOWNLOAD_NETWORK_PROJECT_ID,
      1,
      60_000
    )
    networkDiagnostics = runtime.supervisor.getNetworkFaultDiagnostics()
    networkSummary = runtime.supervisor.getDownloadSummary()
  } finally {
    runtime.supervisor.disableNetworkEmulationForDiagnostics()
  }

  await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.startProjectRuntime(${JSON.stringify(
      PROJECT_DOWNLOAD_DISK_PROJECT_ID
    )})`
  )
  const diskWorkspace = await waitForProjectRuns(
    runtime,
    PROJECT_DOWNLOAD_DISK_PROJECT_ID,
    1,
    30_000
  )
  const [networkDownloadState, diskDownloadState, runtimeState] =
    await Promise.all([
      networkManager.read(),
      diskManager.read(),
      projectRuntimeStore.read()
    ])
  const networkRecord = networkDownloadState.records[0] ?? null
  const diskRecord = diskDownloadState.records[0] ?? null
  const networkRuntime = runtimeState.runtimes.find(
    ({ runtime: candidate }) =>
      candidate.projectId === PROJECT_DOWNLOAD_NETWORK_PROJECT_ID
  )?.runtime
  const diskRuntime = runtimeState.runtimes.find(
    ({ runtime: candidate }) =>
      candidate.projectId === PROJECT_DOWNLOAD_DISK_PROJECT_ID
  )?.runtime
  const networkTemporaryBytes =
    networkRecord && existsSync(networkRecord.temporaryPath)
      ? statSync(networkRecord.temporaryPath).size
      : null
  const networkDownloads = readDirectoryNames(
    join(networkOutputRoot, 'downloads')
  )
  const networkTemporary = readDirectoryNames(join(networkOutputRoot, 'tmp'))
  const diskDownloads = readDirectoryNames(join(diskOutputRoot, 'downloads'))
  const diskTemporary = readDirectoryNames(join(diskOutputRoot, 'tmp'))
  const networkEventTypes = runtime.events
    .filter((event) => event.runtimeId === networkRuntime?.runtimeId)
    .map((event) => event.type)
  const diskEventTypes = runtime.events
    .filter((event) => event.runtimeId === diskRuntime?.runtimeId)
    .map((event) => event.type)
  const finalNetworkDiagnostics =
    runtime.supervisor.getNetworkFaultDiagnostics()
  const networkTemporaryConsistent =
    (networkTemporaryBytes === null && networkTemporary.length === 0) ||
    (networkTemporaryBytes !== null &&
      networkTemporaryBytes >= 32 * 1024 &&
      networkTemporaryBytes < networkBytes &&
      networkTemporary.length === 1)
  const passed =
    networkWorkspace.runtimes.some(
      (candidate) =>
        candidate.projectId === PROJECT_DOWNLOAD_NETWORK_PROJECT_ID &&
        candidate.status === 'completed'
    ) &&
    diskWorkspace.runtimes.some(
      (candidate) =>
        candidate.projectId === PROJECT_DOWNLOAD_DISK_PROJECT_ID &&
        candidate.status === 'completed'
    ) &&
    networkDownloadState.records.length === 1 &&
    networkRecord?.status === 'failed' &&
    networkRecord.errorCategory === 'network' &&
    networkRecord.error === 'diagnostic-offline' &&
    networkRecord.retryCount === 1 &&
    networkDownloads.length === 0 &&
    networkTemporaryConsistent &&
    networkRuntime?.status === 'completed' &&
    networkRuntime.counters.failed === 1 &&
    getCheckpointFailureCategory(networkRuntime) === 'network' &&
    networkDiagnostics.offline &&
    networkDiagnostics.armedAfterBytes === null &&
    networkDiagnostics.injectedDrops === 1 &&
    networkSummary.active === 0 &&
    networkSummary.failed === 1 &&
    networkSummary.receivedBytes >= 32 * 1024 &&
    networkEventTypes.includes('download-started') &&
    networkEventTypes.includes('download-progress') &&
    networkEventTypes.includes('download-failed') &&
    diskDownloadState.records.length === 1 &&
    diskRecord?.status === 'failed' &&
    diskRecord.errorCategory === 'disk' &&
    diskRecord.retryCount === 1 &&
    diskDownloads.length === 0 &&
    diskTemporary.length === 0 &&
    diskRuntime?.status === 'completed' &&
    diskRuntime.counters.failed === 1 &&
    getCheckpointFailureCategory(diskRuntime) === 'disk' &&
    diskEventTypes.includes('download-failed') &&
    !diskEventTypes.includes('download-started') &&
    !finalNetworkDiagnostics.offline &&
    finalNetworkDiagnostics.injectedDrops === 1

  const result = {
    passed,
    networkPageUrl,
    diskPageUrl,
    networkBytes,
    diskBytes,
    networkWorkspace,
    diskWorkspace,
    networkDownloadState,
    diskDownloadState,
    networkRuntime,
    diskRuntime,
    networkTemporaryBytes,
    networkTemporaryConsistent,
    networkDownloads,
    networkTemporary,
    diskDownloads,
    diskTemporary,
    networkDiagnostics,
    finalNetworkDiagnostics,
    networkSummary,
    networkEventTypes,
    diskEventTypes
  }
  writeProjectDownloadFaultSmokeChildResult(result)
  console.log(
    `AGENTIC_BROWSER_PROJECT_DOWNLOAD_FAULT_CHILD ${JSON.stringify(result)}`
  )
  await closeSmokeRuntime(runtime)
  app.exit(passed ? 0 : 1)
}

export async function runProjectDownloadRendererRecoverySmokeChild(
  runtime: MainWindowRuntime,
  projectRuntimeStore: ProjectRuntimeStore,
  profileId: string
): Promise<void> {
  const pageUrl = requireEnvironmentValue(
    'AGENTIC_PROJECT_DOWNLOAD_RENDERER_URL'
  )
  const outputRoot = requireEnvironmentValue(
    'AGENTIC_PROJECT_DOWNLOAD_RENDERER_OUTPUT_ROOT'
  )
  const expectedSha256 = requireEnvironmentValue(
    'AGENTIC_PROJECT_DOWNLOAD_RENDERER_EXPECTED_SHA256'
  )
  const expectedBytes = parsePositiveInteger(
    requireEnvironmentValue('AGENTIC_PROJECT_DOWNLOAD_RENDERER_EXPECTED_BYTES'),
    'AGENTIC_PROJECT_DOWNLOAD_RENDERER_EXPECTED_BYTES'
  )
  const downloadManager = new ProjectDownloadManager(
    join(outputRoot, 'records', 'downloads.json')
  )
  const strategyDraft = createProjectDownloadRecoveryStrategyDraft(
    pageUrl,
    expectedBytes
  )
  const projectDraft = createProjectDownloadRecoveryProjectDraft({
    profileId,
    pageUrl,
    outputRoot,
    expectedBytes
  })
  await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.saveStrategy(${JSON.stringify(strategyDraft)})`
  )
  await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.saveProject(${JSON.stringify(projectDraft)})`
  )
  const started = (await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.startProjectRuntime(${JSON.stringify(
      PROJECT_DOWNLOAD_RECOVERY_PROJECT_ID
    )})`
  )) as ProjectWorkspaceSnapshot
  const interrupted = await waitForPartialProjectDownload(
    downloadManager,
    expectedBytes,
    30_000
  )
  const runtimeStateBefore = await projectRuntimeStore.read()
  const activeRuntime = runtimeStateBefore.runtimes.find(
    ({ runtime: candidate }) =>
      candidate.projectId === PROJECT_DOWNLOAD_RECOVERY_PROJECT_ID &&
      !isTerminalProjectRuntime(candidate)
  )?.runtime
  if (!activeRuntime) {
    throw new Error('下载 renderer 恢复 smoke 在强杀前没有活动 Runtime')
  }

  const mainPid = process.pid
  const generationBefore = runtime.supervisor.getSnapshot().generation
  await runtime.supervisor.forceCrashAndWait(20_000)
  const generationAfter = runtime.supervisor.getSnapshot().generation
  const completedDownloads = await waitForCompletedDownloads(
    downloadManager,
    1,
    60_000
  )
  const completedWorkspace = await waitForProjectRuns(
    runtime,
    PROJECT_DOWNLOAD_RECOVERY_PROJECT_ID,
    1,
    60_000
  )
  const runtimeStateAfter = await projectRuntimeStore.read()
  const completedRuntime = runtimeStateAfter.runtimes.find(
    ({ runtime: candidate }) => candidate.runtimeId === activeRuntime.runtimeId
  )?.runtime
  const completedRecords = completedDownloads.records.filter(
    (record) => record.status === 'completed'
  )
  const failedRecords = completedDownloads.records.filter(
    (record) => record.status === 'failed'
  )
  const completedRecord = completedRecords[0] ?? null
  const finalPayload = completedRecord
    ? readFileSync(completedRecord.finalPath)
    : Buffer.alloc(0)
  const finalSha256 = createHash('sha256').update(finalPayload).digest('hex')
  const downloads = readDirectoryNames(join(outputRoot, 'downloads'))
  const temporary = readDirectoryNames(join(outputRoot, 'tmp'))
  const runtimeEvents = runtime.events.filter(
    (event) => event.runtimeId === activeRuntime.runtimeId
  )
  const eventTypes = runtimeEvents.map((event) => event.type)
  const strategyStarts = runtimeEvents.filter(
    (event) => event.type === 'strategy-started'
  ).length
  const passed =
    process.pid === mainPid &&
    generationAfter > generationBefore &&
    interrupted.receivedBytes > 0 &&
    interrupted.receivedBytes < expectedBytes &&
    completedWorkspace.runtimes.some(
      (candidate) =>
        candidate.runtimeId === activeRuntime.runtimeId &&
        candidate.status === 'completed'
    ) &&
    completedDownloads.records.length === 1 &&
    completedRecords.length === 1 &&
    failedRecords.length === 0 &&
    completedRecord?.runtimeId === activeRuntime.runtimeId &&
    completedRecord.size === expectedBytes &&
    completedRecord.sha256 === expectedSha256 &&
    finalPayload.byteLength === expectedBytes &&
    finalSha256 === expectedSha256 &&
    downloads.length === 1 &&
    temporary.length === 0 &&
    completedRuntime?.status === 'completed' &&
    completedRuntime.runtimeId === activeRuntime.runtimeId &&
    completedRuntime.counters.downloaded === 1 &&
    completedRuntime.counters.failed === 0 &&
    completedRuntime.counters.downloadedBytes === expectedBytes &&
    eventTypes.includes('renderer-gone') &&
    eventTypes.includes('recreated') &&
    eventTypes.includes('recovery-succeeded') &&
    eventTypes.includes('download-completed') &&
    strategyStarts >= 2

  const result = {
    passed,
    mainPid,
    projectId: PROJECT_DOWNLOAD_RECOVERY_PROJECT_ID,
    runtimeId: activeRuntime.runtimeId,
    pageUrl,
    expectedBytes,
    expectedSha256,
    generationBefore,
    generationAfter,
    interrupted,
    started,
    completedWorkspace,
    downloadState: completedDownloads,
    completedRuntime,
    downloads,
    temporary,
    finalSha256,
    eventTypes,
    strategyStarts
  }
  writeProjectDownloadRendererSmokeChildResult(result)
  console.log(
    `AGENTIC_BROWSER_PROJECT_DOWNLOAD_RENDERER_RECOVERY_CHILD ${JSON.stringify(
      result
    )}`
  )
  await closeSmokeRuntime(runtime)
  app.exit(passed ? 0 : 1)
}

export function getCheckpointFailureCategory(
  runtime: ProjectRuntimeSnapshot
): WorkflowFailureCategory | null {
  const lastEvent = runtime.checkpointData.lastEvent
  if (
    typeof lastEvent !== 'object' ||
    lastEvent === null ||
    Array.isArray(lastEvent)
  ) {
    return null
  }
  const payload = lastEvent.payload
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return null
  }
  const category = payload.category
  return typeof category === 'string' &&
    [
      'network',
      'timeout',
      'authentication',
      'page-changed',
      'renderer',
      'disk',
      'cancelled',
      'unknown'
    ].includes(category)
    ? (category as WorkflowFailureCategory)
    : null
}

export async function runAutomationPlaygroundSmoke(
  runtime: MainWindowRuntime,
  outputRoot: string
): Promise<Record<string, unknown>> {
  const profiles = (await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.createProfile('Public Automation Pilot')`
  )) as ProfileSummary[]
  const projectProfile = profiles.find(
    (profile) => profile.name === 'Public Automation Pilot'
  )
  if (!projectProfile) {
    throw new Error('公开站点自动化验收未能创建 Profile')
  }

  const installed = (await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.installAutomationPlayground(${JSON.stringify(
      projectProfile.id
    )})`
  )) as AutomationPlaygroundInstallResult
  const createEnabledDraft = (entryUrl: string): ProjectDraft => ({
    ...createAutomationPlaygroundProjectDraft({
      profileId: projectProfile.id,
      outputRoot,
      entryUrl,
      runtimeMode: 'manual',
      maxRunMs: 90_000
    }),
    enabled: true
  })
  await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.saveProject(${JSON.stringify(
      createEnabledDraft(AUTOMATION_PLAYGROUND_FORM_URL)
    )})`
  )

  const itemStore = new ProjectItemStore(
    join(outputRoot, 'records', 'items.json')
  )
  const downloadManager = new ProjectDownloadManager(
    join(outputRoot, 'records', 'downloads.json')
  )
  await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.startProjectRuntime(${JSON.stringify(
      AUTOMATION_PLAYGROUND_PROJECT_ID
    )})`
  )
  const firstWorkspace = await waitForProjectRuns(
    runtime,
    AUTOMATION_PLAYGROUND_PROJECT_ID,
    1,
    60_000
  )
  const firstItems = await itemStore.read()
  const firstDownloads = await waitForCompletedDownloads(
    downloadManager,
    1,
    30_000
  )

  await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.startProjectRuntime(${JSON.stringify(
      AUTOMATION_PLAYGROUND_PROJECT_ID
    )})`
  )
  const crashTarget = await waitForProjectRuntimeNode(
    runtime,
    AUTOMATION_PLAYGROUND_PROJECT_ID,
    'wait-dynamic',
    45_000
  )
  const generationBeforeCrash = runtime.supervisor.getSnapshot().generation
  await runtime.supervisor.forceCrashAndWait(20_000)
  const generationAfterCrash = runtime.supervisor.getSnapshot().generation
  const secondWorkspace = await waitForProjectRuns(
    runtime,
    AUTOMATION_PLAYGROUND_PROJECT_ID,
    2,
    60_000
  )
  const secondItems = await itemStore.read()
  const secondDownloads = await downloadManager.read()

  await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.saveProject(${JSON.stringify(
      createEnabledDraft(AUTOMATION_PLAYGROUND_MISSING_URL)
    )})`
  )
  await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.startProjectRuntime(${JSON.stringify(
      AUTOMATION_PLAYGROUND_PROJECT_ID
    )})`
  )
  const pageChangedPaused = await waitForProjectRuntimeStatus(
    runtime,
    AUTOMATION_PLAYGROUND_PROJECT_ID,
    'paused',
    45_000
  )
  const manualSnapshot = (await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.navigate(${JSON.stringify(
      AUTOMATION_PLAYGROUND_FORM_URL
    )})`
  )) as BrowserSnapshot
  await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.resumeProjectRuntime(${JSON.stringify(
      AUTOMATION_PLAYGROUND_PROJECT_ID
    )})`
  )
  const finalWorkspace = await waitForProjectRuns(
    runtime,
    AUTOMATION_PLAYGROUND_PROJECT_ID,
    3,
    60_000
  )

  const finalItems = await itemStore.read()
  const finalDownloads = await downloadManager.read()
  const downloads = readDirectoryNames(join(outputRoot, 'downloads'))
  const temporary = readDirectoryNames(join(outputRoot, 'tmp'))
  const projectRuntimes = finalWorkspace.runtimes.filter(
    (candidate) => candidate.projectId === AUTOMATION_PLAYGROUND_PROJECT_ID
  )
  const expectedSha256 = createHash('sha256')
    .update('Hello, World!\n')
    .digest('hex')
  const completedDownload = finalDownloads.records.find(
    (record) => record.status === 'completed'
  )
  const takeoverEvents = runtime.events.filter(
    (event) =>
      event.projectId === AUTOMATION_PLAYGROUND_PROJECT_ID &&
      (event.type === 'project-runtime-paused' ||
        event.type === 'project-runtime-resumed')
  )
  const rendererEvents = runtime.events.filter(
    (event) => event.type === 'renderer-gone' || event.type === 'recreated'
  )
  const passed =
    installed.projectWorkspace.projects.some(
      (project) =>
        project.id === AUTOMATION_PLAYGROUND_PROJECT_ID && !project.enabled
    ) &&
    installed.strategyWorkspace.strategies.some(
      (definition) =>
        definition.manifest.id === AUTOMATION_PLAYGROUND_STRATEGY_ID
    ) &&
    firstItems.records.length === 4 &&
    firstItems.records.every((record) => record.seenCount === 1) &&
    firstDownloads.records.length === 1 &&
    secondItems.records.length === 4 &&
    secondItems.records.every((record) => record.seenCount === 2) &&
    secondDownloads.records.length === 1 &&
    finalItems.records.length === 4 &&
    finalItems.records.every(
      (record) => record.classification === 'matched' && record.seenCount === 3
    ) &&
    finalDownloads.records.length === 1 &&
    completedDownload?.sourceUrl === AUTOMATION_PLAYGROUND_DOWNLOAD_FILE_URL &&
    completedDownload.size === 14 &&
    completedDownload.sha256 === expectedSha256 &&
    downloads.length === 1 &&
    temporary.length === 0 &&
    crashTarget.status === 'waiting' &&
    generationAfterCrash > generationBeforeCrash &&
    rendererEvents.some((event) => event.type === 'renderer-gone') &&
    rendererEvents.some((event) => event.type === 'recreated') &&
    pageChangedPaused.lastFailureCategory === 'page-changed' &&
    pageChangedPaused.lastError?.includes('未声明页面') === true &&
    manualSnapshot.url.startsWith(AUTOMATION_PLAYGROUND_FORM_URL) &&
    projectRuntimes.length === 3 &&
    projectRuntimes.every(
      (candidate) =>
        candidate.status === 'completed' &&
        candidate.counters.scanned === 4 &&
        candidate.counters.matched === 4 &&
        candidate.counters.skipped === 0
    ) &&
    projectRuntimes.reduce(
      (total, candidate) => total + candidate.counters.downloaded,
      0
    ) === 1 &&
    takeoverEvents.filter((event) => event.type === 'project-runtime-paused')
      .length === 1 &&
    takeoverEvents.filter((event) => event.type === 'project-runtime-resumed')
      .length === 1

  return {
    passed,
    site: {
      formUrl: AUTOMATION_PLAYGROUND_FORM_URL,
      downloadFileUrl: AUTOMATION_PLAYGROUND_DOWNLOAD_FILE_URL,
      secondSiteUrl: AUTOMATION_PLAYGROUND_SECOND_SITE_URL,
      accountRequired: false,
      writesRemoteData: false
    },
    installed: {
      projectIds: installed.projectWorkspace.projects.map(
        (project) => project.id
      ),
      strategyIds: installed.strategyWorkspace.strategies.map(
        (definition) => definition.manifest.id
      ),
      installedProjectEnabled:
        installed.projectWorkspace.projects.find(
          (project) => project.id === AUTOMATION_PLAYGROUND_PROJECT_ID
        )?.enabled ?? null
    },
    firstWorkspace,
    crashTarget,
    generationBeforeCrash,
    generationAfterCrash,
    secondWorkspace,
    pageChangedPaused,
    manualSnapshot,
    finalWorkspace,
    itemState: finalItems,
    downloadState: finalDownloads,
    downloads,
    temporary,
    takeoverEvents,
    rendererEvents,
    expectedSha256,
    observedEventTypes: [...new Set(runtime.events.map((event) => event.type))]
  }
}

export async function runProjectConcurrencySmoke(
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
      strategies: [{ id: 'smoke-project-concurrency', version: '0.1.0' }],
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
  const afterQueuedStop = await waitForProjectConcurrency(runtime, 15_000, 1)
  const [alphaCookie, betaCookie] = await Promise.all([
    waitForProfileCookie(profileA.id, probe.topUrl, 'concurrency-alpha'),
    waitForProfileCookie(profileB.id, probe.topUrl, 'concurrency-beta')
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
        records[0].finalPath.startsWith(join(download.root, 'downloads')) &&
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
    observedEventTypes: [...new Set(runtime.events.map((event) => event.type))]
  }
}

export async function runProjectTakeoverSmoke(
  runtime: MainWindowRuntime,
  probe: PhaseZeroProbeServer,
  profileId: string,
  outputRoot: string
): Promise<Record<string, unknown>> {
  const profiles = (await runtime.shellView.webContents.executeJavaScript(
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
    strategies: [{ id: 'smoke-project-takeover', version: '0.1.0' }],
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
  const beforeMonitor = (await runtime.shellView.webContents.executeJavaScript(
    'window.agenticBrowser.getMonitorSnapshot()'
  )) as MonitorSnapshot

  await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.pauseProjectRuntime(${JSON.stringify(draft.id)})`
  )
  const paused = await waitForProjectRuntimeStatus(runtime, draft.id, 'paused')
  const pausedMonitor = (await runtime.shellView.webContents.executeJavaScript(
    'window.agenticBrowser.getMonitorSnapshot()'
  )) as MonitorSnapshot
  const manualSnapshot = (await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.navigate(${JSON.stringify(manualUrl.toString())})`
  )) as BrowserSnapshot
  await new Promise((resolve) => setTimeout(resolve, 500))
  const duringManual = await waitForProjectRuntimeStatus(
    runtime,
    draft.id,
    'paused'
  )
  const manualMonitor = (await runtime.shellView.webContents.executeJavaScript(
    'window.agenticBrowser.getMonitorSnapshot()'
  )) as MonitorSnapshot

  await runtime.shellView.webContents.executeJavaScript(
    `window.agenticBrowser.resumeProjectRuntime(${JSON.stringify(draft.id)})`
  )
  const completed = await waitForProjectSet(runtime, [draft.id])
  const finalRuntime = [...completed.runtimes]
    .reverse()
    .find((candidate) => candidate.projectId === draft.id)
  const finalMonitor = (await runtime.shellView.webContents.executeJavaScript(
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

  const stoppedBlocker = (await runtime.shellView.webContents.executeJavaScript(
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

export async function waitForProjectConcurrency(
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
  throw new Error(`等待 Project 并发执行超时：${JSON.stringify(latest)}`)
}

export async function waitForProjectRuntimeStatus(
  runtime: MainWindowRuntime,
  projectId: string,
  expectedStatus: ProjectRuntimeSnapshot['status'],
  timeoutMs = 15_000
): Promise<ProjectRuntimeSnapshot> {
  const deadline = Date.now() + timeoutMs
  let latest: ProjectRuntimeSnapshot | null = null
  while (Date.now() < deadline) {
    const workspace = (await runtime.shellView.webContents.executeJavaScript(
      'window.agenticBrowser.getProjectWorkspace()'
    )) as ProjectWorkspaceSnapshot
    latest =
      [...workspace.runtimes]
        .reverse()
        .find((candidate) => candidate.projectId === projectId) ?? null
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

export async function waitForProjectRuntimeNode(
  runtime: MainWindowRuntime,
  projectId: string,
  expectedNodeId: string,
  timeoutMs = 15_000
): Promise<ProjectRuntimeSnapshot> {
  const deadline = Date.now() + timeoutMs
  let latest: ProjectRuntimeSnapshot | null = null
  while (Date.now() < deadline) {
    const workspace = (await runtime.shellView.webContents.executeJavaScript(
      'window.agenticBrowser.getProjectWorkspace()'
    )) as ProjectWorkspaceSnapshot
    latest =
      [...workspace.runtimes]
        .reverse()
        .find((candidate) => candidate.projectId === projectId) ?? null
    if (
      latest?.currentNodeId === expectedNodeId &&
      latest.status === 'waiting' &&
      !isTerminalProjectRuntime(latest)
    ) {
      return latest
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(
    `等待 Project Runtime 节点 ${expectedNodeId} 超时：` +
      JSON.stringify(latest)
  )
}

export async function waitForProjectSet(
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
      selected.every((candidate) => isTerminalProjectRuntime(candidate))
    ) {
      return latest
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`等待并发 Project 完成超时：${JSON.stringify(latest)}`)
}

export async function waitForProfileCookie(
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

export async function waitForProjectRuns(
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
      projectRuntimes.every((candidate) => isTerminalProjectRuntime(candidate))
    ) {
      return latest
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`等待 Project Runtime 完成超时：${JSON.stringify(latest)}`)
}

export async function waitForCompletedDownloads(
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
      state.records.filter((record) => record.status === 'completed').length >=
      minimumCompleted
    ) {
      return state
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`等待 Project 下载完成超时：${JSON.stringify(latest)}`)
}

export function readDirectoryNames(path: string): string[] {
  try {
    return readdirSync(path).sort()
  } catch {
    return []
  }
}

export async function captureStrategyWorkspaceStep(
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

export async function runWatchdogSmokeChild(
  runtime: MainWindowRuntime,
  restoredCheckpoint: BrowserCheckpoint | null,
  requestedUrl: string | undefined
): Promise<void> {
  const resultPath = process.env.AGENTIC_WATCHDOG_CHILD_RESULT_PATH
  if (!resultPath) {
    throw new Error('Watchdog smoke 缺少结果文件路径')
  }

  const checkpoint = await runtime.supervisor.flushCheckpoint(
    watchdogRestartCount === 0
      ? 'watchdog-smoke-ready'
      : 'watchdog-smoke-restored'
  )
  const snapshot = runtime.supervisor.getSnapshot()
  const profileCookiePresent = await runtime.supervisor.hasProfileCookie(
    'agentic_watchdog_session'
  )
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
    heartbeatActive: getMainProcessHeartbeat() !== null,
    startupSettings,
    startupIntegrationPassed
  }

  await writeJsonAtomic(resultPath, result)
  console.log(`AGENTIC_BROWSER_WATCHDOG_CHILD ${JSON.stringify(result)}`)

  if (watchdogRestartCount > 0) {
    runtime.window.close()
    await getMainProcessHeartbeat()?.stop()
    app.exit(passed ? 0 : 1)
  }
}

export async function runRecoverySmoke(
  runtime: MainWindowRuntime,
  probe: PhaseZeroProbeServer
): Promise<Record<string, unknown>> {
  const popupUrl = new URL('/popup', probe.topUrl).toString()
  const profileCookieName = 'agentic_profile_smoke'
  await runtime.supervisor.setProfileCookieForDiagnostics(
    profileCookieName,
    'default-profile'
  )
  const createdProfiles =
    (await runtime.shellView.webContents.executeJavaScript(
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

export function cleanupAutomatedDownloads(directory: string | null): void {
  if (directory) {
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100
    })
  }
}

export async function waitForStrategyRuntime(
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

export function createCheckpointStore(): BrowserCheckpointStore | undefined {
  if (
    smokeTest ||
    recoverySmokeTest ||
    strategyFaultSmokeTest ||
    strategyWorkspaceSmokeTest ||
    projectDownloadSmokeTest ||
    projectConcurrencySmokeTest ||
    projectTakeoverSmokeTest ||
    automationPlaygroundSmokeTest
  ) {
    return undefined
  }

  return new BrowserCheckpointStore(
    process.env.AGENTIC_CHECKPOINT_PATH ??
      join(app.getPath('userData'), 'runtime', 'browser-checkpoint.json')
  )
}

export async function runStrategyFaultSmoke(
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
    observedEventTypes: [...new Set(runtime.events.map((event) => event.type))],
    strategyEvents: runtime.events.filter((event) =>
      event.type.startsWith('strategy-')
    )
  }
}

export async function runStrategyWorkspaceSmoke(
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
    (generation, index) => index === 0 || generation > generations[index - 1]!
  )
  const reloadedEventCount = runtime.events.filter(
    (event) => event.type === 'strategy-reloaded'
  ).length
  const passed =
    savedV1.strategies.length === 1 &&
    savedV1.developmentAllowedStrategyIds.length === 0 &&
    afterSave.activeCount === 0 &&
    afterSave.nodeMarker === null &&
    allowed.developmentAllowedStrategyIds.includes(draftV1.manifest.id) &&
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
