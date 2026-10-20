import type {
  BrowserSnapshot,
  DownloadSummary,
  MonitorSnapshot,
  ProcessMetric,
  ProjectRuntimeSnapshot,
  StrategyRuntimeSnapshot
} from '../shared/contracts'
import { isTerminalProjectRuntime } from './main-helpers'

// 监控快照的聚合规则：多 supervisor、多 project runtime 的合并。
// 这部分此前埋在 index.ts 里，只能靠真实窗口产生数据来观察，
// 其中的去重、计数与求和边界从未被单独验证。
//
// 只声明聚合所需的最小接口，而不是重新定义一份快照类型，
// 避免出现与 contracts 分叉的第二份真相。

export interface SupervisorLike {
  getStrategyRuntimeSnapshot: () => StrategyRuntimeSnapshot
  getDownloadSummary: () => DownloadSummary
  getSnapshot: () => BrowserSnapshot
  listTabs: () => unknown[]
}

export function countActiveProjectRuntimes(
  runtimes: ProjectRuntimeSnapshot[]
): number {
  return runtimes.filter(
    (runtime) =>
      runtime.status !== 'queued' &&
      runtime.status !== 'paused' &&
      !isTerminalProjectRuntime(runtime)
  ).length
}

export function countProjectRuntimesByStatus(
  runtimes: ProjectRuntimeSnapshot[],
  status: string
): number {
  return runtimes.filter((runtime) => runtime.status === status).length
}

export function summarizeStrategySnapshots(
  supervisors: SupervisorLike[]
): StrategyRuntimeSnapshot {
  const snapshots = supervisors.map((current) =>
    current.getStrategyRuntimeSnapshot()
  )
  return {
    activeCount: snapshots.reduce(
      (total, snapshot) => total + snapshot.activeCount,
      0
    ),
    // 隔离名单按 id 去重后排序：同一个策略可能同时在多个 supervisor
    // 里被隔离，重复出现会让上层误判影响面。排序只为输出稳定。
    quarantinedStrategyIds: [
      ...new Set(
        snapshots.flatMap((snapshot) => snapshot.quarantinedStrategyIds)
      )
    ].sort(),
    entries: snapshots.flatMap((snapshot) => snapshot.entries)
  }
}

export function summarizeDownloads(
  supervisors: SupervisorLike[]
): DownloadSummary {
  return supervisors.reduce<DownloadSummary>(
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
}

export function buildMonitorSnapshot(input: {
  supervisor: SupervisorLike
  additionalSupervisors?: SupervisorLike[]
  browserEventCount: number
  projectRuntime?: ProjectRuntimeSnapshot | null
  projectRuntimes?: ProjectRuntimeSnapshot[]
  processes: ProcessMetric[]
  generatedAt?: string
}): MonitorSnapshot {
  const {
    supervisor,
    additionalSupervisors = [],
    browserEventCount,
    projectRuntime = null,
    projectRuntimes = [],
    processes,
    generatedAt = new Date().toISOString()
  } = input

  const supervisors = [supervisor, ...additionalSupervisors]
  const strategies = summarizeStrategySnapshots(supervisors)
  const downloads = summarizeDownloads(supervisors)

  return {
    generatedAt,
    browser: supervisor.getSnapshot(),
    projectRuntime,
    projectRuntimes: projectRuntimes.map((runtime) => structuredClone(runtime)),
    activeProjectCount: countActiveProjectRuntimes(projectRuntimes),
    pausedProjectCount: countProjectRuntimesByStatus(projectRuntimes, 'paused'),
    queuedProjectCount: countProjectRuntimesByStatus(projectRuntimes, 'queued'),
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
