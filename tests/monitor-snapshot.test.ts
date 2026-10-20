import { describe, expect, it } from 'vitest'

import {
  buildMonitorSnapshot,
  countActiveProjectRuntimes,
  countProjectRuntimesByStatus,
  summarizeDownloads,
  summarizeStrategySnapshots,
  type SupervisorLike
} from '../src/main/monitor-snapshot'
import type {
  BrowserSnapshot,
  DownloadSummary,
  ProjectRuntimeSnapshot,
  StrategyRuntimeSnapshot
} from '../src/shared/contracts'

function strategySnapshot(
  overrides: Partial<StrategyRuntimeSnapshot> = {}
): StrategyRuntimeSnapshot {
  return {
    activeCount: 0,
    quarantinedStrategyIds: [],
    entries: [],
    ...overrides
  }
}

function downloadSummary(
  overrides: Partial<DownloadSummary> = {}
): DownloadSummary {
  return {
    active: 0,
    completed: 0,
    failed: 0,
    receivedBytes: 0,
    ...overrides
  }
}

function supervisor(overrides: Partial<SupervisorLike> = {}): SupervisorLike {
  return {
    getStrategyRuntimeSnapshot: () => strategySnapshot(),
    getDownloadSummary: () => downloadSummary(),
    getSnapshot: () => ({}) as BrowserSnapshot,
    listTabs: () => [],
    ...overrides
  }
}

function runtime(
  overrides: Partial<ProjectRuntimeSnapshot> = {}
): ProjectRuntimeSnapshot {
  return {
    runtimeId: 'runtime-1',
    projectId: 'project-1',
    projectRevision: 1,
    trigger: 'manual',
    status: 'running',
    currentNodeId: 'start',
    nodeAttempt: 0,
    checkpointNodeId: null,
    checkpointData: {},
    lastHeartbeatAt: '2026-01-01T00:00:00.000Z',
    nextWakeAt: null,
    lastError: null,
    lastFailureCategory: null,
    counters: {
      scanned: 0,
      matched: 0,
      skipped: 0,
      downloaded: 0,
      failed: 0,
      downloadedBytes: 0
    },
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    ...overrides
  }
}

describe('summarizeStrategySnapshots', () => {
  it('sums active counts across supervisors', () => {
    const result = summarizeStrategySnapshots([
      supervisor({
        getStrategyRuntimeSnapshot: () => strategySnapshot({ activeCount: 2 })
      }),
      supervisor({
        getStrategyRuntimeSnapshot: () => strategySnapshot({ activeCount: 3 })
      })
    ])
    expect(result.activeCount).toBe(5)
  })

  it('dedupes quarantined ids shared by several supervisors', () => {
    // 同一个策略被多个 supervisor 同时隔离时，上层看到的影响面
    // 应该是一个策略，而不是 N 个。
    const result = summarizeStrategySnapshots([
      supervisor({
        getStrategyRuntimeSnapshot: () =>
          strategySnapshot({
            quarantinedStrategyIds: ['a', 'b']
          })
      }),
      supervisor({
        getStrategyRuntimeSnapshot: () =>
          strategySnapshot({
            quarantinedStrategyIds: ['b', 'c']
          })
      })
    ])
    expect(result.quarantinedStrategyIds).toEqual(['a', 'b', 'c'])
  })

  it('sorts quarantined ids so output is stable', () => {
    const result = summarizeStrategySnapshots([
      supervisor({
        getStrategyRuntimeSnapshot: () =>
          strategySnapshot({ quarantinedStrategyIds: ['z', 'm', 'a'] })
      })
    ])
    expect(result.quarantinedStrategyIds).toEqual(['a', 'm', 'z'])
  })

  it('concatenates entries rather than deduping them', () => {
    // 条目代表的是运行实例，同一策略在两个 supervisor 里是两个
    // 真实实例，不能合并。
    const entry = {
      strategyId: 's',
      name: 'S',
      version: '1',
      url: 'https://a.test',
      isMainFrame: true,
      status: 'running' as const,
      startedAt: null,
      lastHeartbeatAt: null,
      failure: null
    }
    const result = summarizeStrategySnapshots([
      supervisor({
        getStrategyRuntimeSnapshot: () => strategySnapshot({ entries: [entry] })
      }),
      supervisor({
        getStrategyRuntimeSnapshot: () => strategySnapshot({ entries: [entry] })
      })
    ])
    expect(result.entries).toHaveLength(2)
  })

  it('handles no supervisors', () => {
    expect(summarizeStrategySnapshots([])).toEqual({
      activeCount: 0,
      quarantinedStrategyIds: [],
      entries: []
    })
  })
})

describe('summarizeDownloads', () => {
  it('accumulates every counter across supervisors', () => {
    const result = summarizeDownloads([
      supervisor({
        getDownloadSummary: () =>
          downloadSummary({
            active: 1,
            completed: 2,
            failed: 3,
            receivedBytes: 100
          })
      }),
      supervisor({
        getDownloadSummary: () =>
          downloadSummary({
            active: 4,
            completed: 5,
            failed: 6,
            receivedBytes: 200
          })
      })
    ])
    expect(result).toEqual({
      active: 5,
      completed: 7,
      failed: 9,
      receivedBytes: 300
    })
  })

  it('returns zeroed counters for an empty list', () => {
    expect(summarizeDownloads([])).toEqual({
      active: 0,
      completed: 0,
      failed: 0,
      receivedBytes: 0
    })
  })

  it('does not mutate the supervisor summaries it reads', () => {
    const source = downloadSummary({ active: 1, receivedBytes: 50 })
    summarizeDownloads([supervisor({ getDownloadSummary: () => source })])
    expect(source.active).toBe(1)
    expect(source.receivedBytes).toBe(50)
  })
})

describe('countActiveProjectRuntimes', () => {
  it('counts running runtimes only', () => {
    expect(
      countActiveProjectRuntimes([
        runtime({ status: 'running' }),
        runtime({ status: 'starting' })
      ])
    ).toBe(2)
  })

  it('excludes queued and paused runtimes', () => {
    // 排队与暂停都不消耗自动化资源，计入活跃数会误导容量判断。
    expect(
      countActiveProjectRuntimes([
        runtime({ status: 'queued' }),
        runtime({ status: 'paused' })
      ])
    ).toBe(0)
  })

  it('excludes terminal runtimes', () => {
    const terminal: ProjectRuntimeSnapshot['status'][] = [
      'completed',
      'failed',
      'cancelled'
    ]
    for (const status of terminal) {
      expect(countActiveProjectRuntimes([runtime({ status })])).toBe(0)
    }
  })

  it('returns zero for an empty list', () => {
    expect(countActiveProjectRuntimes([])).toBe(0)
  })
})

describe('countProjectRuntimesByStatus', () => {
  it('counts only the requested status', () => {
    const runtimes = [
      runtime({ status: 'queued' }),
      runtime({ status: 'queued' }),
      runtime({ status: 'running' })
    ]
    expect(countProjectRuntimesByStatus(runtimes, 'queued')).toBe(2)
    expect(countProjectRuntimesByStatus(runtimes, 'running')).toBe(1)
    expect(countProjectRuntimesByStatus(runtimes, 'paused')).toBe(0)
  })
})

describe('buildMonitorSnapshot', () => {
  it('aggregates a single supervisor with no projects', () => {
    const snapshot = buildMonitorSnapshot({
      supervisor: supervisor({
        getStrategyRuntimeSnapshot: () => strategySnapshot({ activeCount: 2 }),
        getDownloadSummary: () => downloadSummary({ completed: 1 }),
        listTabs: () => [{}, {}]
      }),
      browserEventCount: 7,
      processes: [],
      generatedAt: '2026-01-01T00:00:00.000Z'
    })

    expect(snapshot.generatedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(snapshot.browserEventCount).toBe(7)
    expect(snapshot.activePageCount).toBe(2)
    expect(snapshot.activeStrategyCount).toBe(2)
    expect(snapshot.downloads.completed).toBe(1)
    expect(snapshot.projectRuntime).toBeNull()
    expect(snapshot.activeProjectCount).toBe(0)
  })

  it('sums process cpu and memory', () => {
    const snapshot = buildMonitorSnapshot({
      supervisor: supervisor(),
      browserEventCount: 0,
      processes: [
        { pid: 1, type: 'Browser', cpuPercent: 1.5, workingSetBytes: 1000 },
        { pid: 2, type: 'Tab', cpuPercent: 2.5, workingSetBytes: 2000 }
      ]
    })
    expect(snapshot.totalCpuPercent).toBe(4)
    expect(snapshot.totalWorkingSetBytes).toBe(3000)
    expect(snapshot.processes).toHaveLength(2)
  })

  it('counts pages across primary and additional supervisors', () => {
    const snapshot = buildMonitorSnapshot({
      supervisor: supervisor({ listTabs: () => [{}] }),
      additionalSupervisors: [supervisor({ listTabs: () => [{}, {}] })],
      browserEventCount: 0,
      processes: []
    })
    expect(snapshot.activePageCount).toBe(3)
  })

  it('classifies project runtimes by status', () => {
    const snapshot = buildMonitorSnapshot({
      supervisor: supervisor(),
      browserEventCount: 0,
      projectRuntimes: [
        runtime({ status: 'running' }),
        runtime({ status: 'paused' }),
        runtime({ status: 'queued' }),
        runtime({ status: 'queued' }),
        runtime({ status: 'failed' })
      ],
      processes: []
    })
    expect(snapshot.activeProjectCount).toBe(1)
    expect(snapshot.pausedProjectCount).toBe(1)
    expect(snapshot.queuedProjectCount).toBe(2)
  })

  it('clones runtimes so callers cannot mutate monitor state', () => {
    const source = runtime({ status: 'running' })
    const snapshot = buildMonitorSnapshot({
      supervisor: supervisor(),
      browserEventCount: 0,
      projectRuntimes: [source],
      processes: []
    })
    expect(snapshot.projectRuntimes[0]).not.toBe(source)
    expect(snapshot.projectRuntimes[0]).toEqual(source)
  })
})
