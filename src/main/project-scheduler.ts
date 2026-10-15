import type {
  ProjectDefinition,
  ProjectRuntimeRecord
} from '../shared/contracts'
import type {
  ProjectRuntimeEnvelope,
  ProjectRuntimeStore
} from './project-runtime-store'
import type { ProjectStore } from './project-store'

export interface ProjectSchedulerHost {
  startRuntime(envelope: ProjectRuntimeEnvelope): Promise<void>
  timeoutRuntime(
    envelope: ProjectRuntimeEnvelope,
    reason: string
  ): Promise<void>
  reportError?(operation: string, error: unknown): void
}

export interface ProjectSchedulerOptions {
  maxConcurrent?: number
  tickIntervalMs?: number | null
  now?: () => number
}

export interface ProjectSchedulerSnapshot {
  maxConcurrent: number
  executing: number
  queued: number
  suspendedProjectIds: string[]
}

const EXECUTING_STATUSES = new Set<ProjectRuntimeRecord['status']>([
  'starting',
  'running',
  'waiting',
  'recovering'
])
const TERMINAL_STATUSES = new Set<ProjectRuntimeRecord['status']>([
  'failed',
  'completed',
  'cancelled'
])
const TRIGGER_PRIORITY: Record<ProjectRuntimeRecord['trigger'], number> = {
  resume: 5,
  manual: 4,
  resident: 3,
  autostart: 2,
  schedule: 1
}

export class ProjectScheduler {
  private readonly maxConcurrent: number
  private readonly tickIntervalMs: number | null
  private readonly now: () => number
  private queue = Promise.resolve()
  private timer: NodeJS.Timeout | null = null
  private started = false
  private disposed = false
  private readonly dispatchingRuntimeIds = new Set<string>()
  private readonly timingOutRuntimeIds = new Set<string>()
  private readonly executionStartedAt = new Map<string, number>()
  private readonly suspendedProjectIds = new Set<string>()
  private readonly autostartAttemptedProjectIds = new Set<string>()
  private readonly residentRetryAt = new Map<string, number>()

  constructor(
    private readonly projectStore: ProjectStore,
    private readonly runtimeStore: ProjectRuntimeStore,
    private readonly host: ProjectSchedulerHost,
    options: ProjectSchedulerOptions = {}
  ) {
    this.maxConcurrent = options.maxConcurrent ?? 1
    this.tickIntervalMs =
      options.tickIntervalMs === undefined ? 1_000 : options.tickIntervalMs
    this.now = options.now ?? Date.now
    if (
      !Number.isSafeInteger(this.maxConcurrent) ||
      this.maxConcurrent < 1 ||
      this.maxConcurrent > 32
    ) {
      throw new Error('Project Scheduler 并发预算必须在 1 到 32 之间')
    }
    if (
      this.tickIntervalMs !== null &&
      (!Number.isSafeInteger(this.tickIntervalMs) ||
        this.tickIntervalMs < 100 ||
        this.tickIntervalMs > 60_000)
    ) {
      throw new Error('Project Scheduler tick 间隔无效')
    }
  }

  start(): Promise<void> {
    return this.enqueue(async () => {
      if (this.started) {
        return
      }
      this.assertAvailable()
      this.started = true
      await this.runCycle()
      if (this.tickIntervalMs !== null) {
        this.timer = setInterval(() => {
          void this.tick().catch((error: unknown) => {
            this.host.reportError?.('scheduler-tick', error)
          })
        }, this.tickIntervalMs)
        this.timer.unref()
      }
    })
  }

  tick(): Promise<void> {
    return this.enqueue(() => this.runCycle())
  }

  async requestManual(projectId: string): Promise<ProjectRuntimeEnvelope> {
    return this.enqueue(async () => {
      this.assertAvailable()
      const project = await this.requireRunnableProject(projectId)
      this.suspendedProjectIds.delete(projectId)
      const envelope = await this.runtimeStore.create(project, 'manual')
      await this.dispatchQueuedRuntimes()
      return envelope
    })
  }

  suspend(projectId: string): void {
    this.suspendedProjectIds.add(projectId)
    this.residentRetryAt.delete(projectId)
  }

  resume(projectId: string): void {
    this.suspendedProjectIds.delete(projectId)
    void this.tick().catch((error: unknown) => {
      this.host.reportError?.('scheduler-resume', error)
    })
  }

  notifyRuntimeTerminal(runtime: ProjectRuntimeRecord): void {
    this.dispatchingRuntimeIds.delete(runtime.runtimeId)
    this.timingOutRuntimeIds.delete(runtime.runtimeId)
    this.executionStartedAt.delete(runtime.runtimeId)
    void this.enqueue(async () => {
      const state = await this.runtimeStore.read()
      const envelope = state.runtimes.find(
        (candidate) =>
          candidate.runtime.runtimeId === runtime.runtimeId
      )
      if (
        envelope?.projectSnapshot.runtime.mode === 'resident' &&
        !this.suspendedProjectIds.has(runtime.projectId)
      ) {
        this.residentRetryAt.set(
          runtime.projectId,
          this.now() + envelope.projectSnapshot.retry.baseBackoffMs
        )
      }
      await this.runCycle()
    }).catch((error: unknown) => {
      this.host.reportError?.('scheduler-terminal', error)
    })
  }

  async getSnapshot(): Promise<ProjectSchedulerSnapshot> {
    const state = await this.runtimeStore.read()
    return {
      maxConcurrent: this.maxConcurrent,
      executing:
        state.runtimes.filter(({ runtime }) =>
          EXECUTING_STATUSES.has(runtime.status)
        ).length + this.dispatchingRuntimeIds.size,
      queued: state.runtimes.filter(
        ({ runtime }) => runtime.status === 'queued'
      ).length,
      suspendedProjectIds: [...this.suspendedProjectIds].sort()
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async runCycle(): Promise<void> {
    this.assertAvailable()
    if (!this.started) {
      return
    }
    await this.ensureAutomaticRuntimes()
    await this.enforceRuntimeDeadlines()
    await this.dispatchQueuedRuntimes()
  }

  private async ensureAutomaticRuntimes(): Promise<void> {
    const [projectState, runtimeState] = await Promise.all([
      this.projectStore.read(),
      this.runtimeStore.read()
    ])
    const activeProjectIds = new Set(
      runtimeState.runtimes
        .filter(({ runtime }) => !TERMINAL_STATUSES.has(runtime.status))
        .map(({ runtime }) => runtime.projectId)
    )

    for (const project of projectState.projects) {
      if (
        !project.enabled ||
        this.suspendedProjectIds.has(project.id) ||
        activeProjectIds.has(project.id)
      ) {
        continue
      }

      const mode = project.runtime.mode
      let trigger: ProjectRuntimeRecord['trigger'] | null = null
      if (mode === 'autostart') {
        if (this.autostartAttemptedProjectIds.has(project.id)) {
          continue
        }
        this.autostartAttemptedProjectIds.add(project.id)
        trigger = 'autostart'
      } else if (mode === 'resident') {
        if ((this.residentRetryAt.get(project.id) ?? 0) > this.now()) {
          continue
        }
        this.residentRetryAt.delete(project.id)
        trigger = 'resident'
      } else if (
        mode === 'schedule' &&
        isProjectScheduleDue(project, runtimeState.runtimes, this.now())
      ) {
        trigger = 'schedule'
      }

      if (trigger) {
        await this.runtimeStore.create(project, trigger)
        activeProjectIds.add(project.id)
      }
    }
  }

  private async enforceRuntimeDeadlines(): Promise<void> {
    const state = await this.runtimeStore.read()
    const now = this.now()
    for (const envelope of state.runtimes) {
      const { runtime, projectSnapshot } = envelope
      if (
        !EXECUTING_STATUSES.has(runtime.status) ||
        this.timingOutRuntimeIds.has(runtime.runtimeId)
      ) {
        continue
      }
      const startedAt =
        this.executionStartedAt.get(runtime.runtimeId) ??
        Date.parse(runtime.startedAt)
      if (now - startedAt < projectSnapshot.runtime.maxRunMs) {
        continue
      }
      this.timingOutRuntimeIds.add(runtime.runtimeId)
      const reason =
        `Project Runtime 超过最大运行时长 ` +
        `${projectSnapshot.runtime.maxRunMs}ms`
      void this.host.timeoutRuntime(
        structuredClone(envelope),
        reason
      ).catch((error: unknown) => {
        this.host.reportError?.('scheduler-timeout', error)
      })
    }
  }

  private async dispatchQueuedRuntimes(): Promise<void> {
    while (!this.disposed) {
      const state = await this.runtimeStore.read()
      const executingRuntimes = state.runtimes.filter(({ runtime }) =>
        EXECUTING_STATUSES.has(runtime.status)
      )
      const executing = executingRuntimes.length
      const occupiedProfileIds = new Set(
        executingRuntimes.map(
          ({ projectSnapshot }) => projectSnapshot.profileId
        )
      )
      const available =
        this.maxConcurrent -
        executing -
        this.dispatchingRuntimeIds.size
      if (available <= 0) {
        return
      }

      const queued = state.runtimes
        .filter(
          ({ runtime }) =>
            runtime.status === 'queued' &&
            !this.dispatchingRuntimeIds.has(runtime.runtimeId)
        )
        .filter(
          ({ projectSnapshot }) =>
            !occupiedProfileIds.has(projectSnapshot.profileId)
        )
        .sort(compareQueuedRuntimes)
      const next = queued[0]
      if (!next) {
        return
      }

      this.dispatchingRuntimeIds.add(next.runtime.runtimeId)
      this.executionStartedAt.set(next.runtime.runtimeId, this.now())
      try {
        await this.host.startRuntime(structuredClone(next))
      } catch (error) {
        await this.handleStartFailure(next, error)
      } finally {
        this.dispatchingRuntimeIds.delete(next.runtime.runtimeId)
      }
    }
  }

  private async handleStartFailure(
    envelope: ProjectRuntimeEnvelope,
    error: unknown
  ): Promise<void> {
    this.executionStartedAt.delete(envelope.runtime.runtimeId)
    const reason =
      error instanceof Error ? error.message : String(error)
    const current = (await this.runtimeStore.read()).runtimes.find(
      (candidate) =>
        candidate.runtime.runtimeId === envelope.runtime.runtimeId
    )
    if (current?.runtime.status === 'queued') {
      await this.runtimeStore.transition(
        current.runtime.runtimeId,
        'cancelled',
        {
          lastError: `Project Runtime 调度启动失败：${reason}`,
          lastFailureCategory: 'unknown'
        }
      )
    }
    if (
      envelope.projectSnapshot.runtime.mode === 'resident' &&
      !this.suspendedProjectIds.has(envelope.runtime.projectId)
    ) {
      this.residentRetryAt.set(
        envelope.runtime.projectId,
        this.now() + envelope.projectSnapshot.retry.baseBackoffMs
      )
    }
    this.host.reportError?.('scheduler-start', error)
  }

  private async requireRunnableProject(
    projectId: string
  ): Promise<ProjectDefinition> {
    const project = (await this.projectStore.read()).projects.find(
      (candidate) => candidate.id === projectId
    )
    if (!project) {
      throw new Error(`Project 不存在：${projectId}`)
    }
    if (!project.enabled) {
      throw new Error(`Project 已禁用：${project.name}`)
    }
    return project
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation)
    this.queue = pending.then(
      () => undefined,
      () => undefined
    )
    return pending
  }

  private assertAvailable(): void {
    if (this.disposed) {
      throw new Error('Project Scheduler 已停止')
    }
  }
}

export function isProjectScheduleDue(
  project: ProjectDefinition,
  runtimes: readonly ProjectRuntimeEnvelope[],
  now: number
): boolean {
  const schedule = project.runtime.schedule
  if (project.runtime.mode !== 'schedule' || !schedule) {
    return false
  }
  const previousRuns = runtimes
    .filter(
      ({ runtime }) =>
        runtime.projectId === project.id &&
        runtime.trigger === 'schedule'
    )
    .map(({ runtime }) => Date.parse(runtime.startedAt))
    .filter(Number.isFinite)

  if (schedule.kind === 'interval') {
    const anchor = Math.max(
      Date.parse(project.updatedAt),
      ...previousRuns
    )
    return now >= anchor + schedule.everyMinutes * 60_000
  }

  const current = zonedMinute(now, project.runtime.timezone)
  const dueTime = [...schedule.times]
    .sort()
    .filter((time) => time <= current.time)
    .at(-1)
  if (!dueTime) {
    return false
  }
  const dueKey = `${current.date}T${dueTime}`
  return !previousRuns.some(
    (startedAt) =>
      zonedMinute(startedAt, project.runtime.timezone).key >= dueKey
  )
}

function compareQueuedRuntimes(
  left: ProjectRuntimeEnvelope,
  right: ProjectRuntimeEnvelope
): number {
  return (
    right.projectSnapshot.runtime.priority -
      left.projectSnapshot.runtime.priority ||
    TRIGGER_PRIORITY[right.runtime.trigger] -
      TRIGGER_PRIORITY[left.runtime.trigger] ||
    Date.parse(left.runtime.startedAt) -
      Date.parse(right.runtime.startedAt) ||
    left.runtime.runtimeId.localeCompare(right.runtime.runtimeId)
  )
}

function zonedMinute(
  epochMs: number,
  timezone: string
): { date: string; time: string; key: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(epochMs))
  const read = (type: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find((part) => part.type === type)?.value
    if (!value) {
      throw new Error(`无法计算 ${timezone} 的本地时间`)
    }
    return value
  }
  const date = `${read('year')}-${read('month')}-${read('day')}`
  const time = `${read('hour')}:${read('minute')}`
  return { date, time, key: `${date}T${time}` }
}
