import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createCapabilityPolicy } from '../src/main/capability-store'
import {
  isProjectScheduleDue,
  ProjectScheduler
} from '../src/main/project-scheduler'
import {
  ProjectRuntimeStore,
  type ProjectRuntimeEnvelope
} from '../src/main/project-runtime-store'
import { ProjectStore } from '../src/main/project-store'
import type {
  ProjectDraft,
  ProjectRuntimeMode,
  ProjectSchedule
} from '../src/shared/contracts'

describe('ProjectScheduler', () => {
  let temporaryRoot: string
  let now: number
  let sequence: number
  let projectStore: ProjectStore
  let runtimeStore: ProjectRuntimeStore

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'agentic-scheduler-test-'))
    now = Date.parse('2026-10-15T00:00:00.000Z')
    sequence = 0
    projectStore = new ProjectStore(join(temporaryRoot, 'projects.json'))
    runtimeStore = new ProjectRuntimeStore(
      join(temporaryRoot, 'runtimes.json'),
      () => now,
      () => `scheduler${++sequence}`
    )
  })

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true })
  })

  it('honors the global concurrency budget and starts the next queued runtime', async () => {
    await projectStore.save(createDraft('project-a', 'manual', 0))
    await projectStore.save(createDraft('project-b', 'manual', 10))
    const projects = (await projectStore.read()).projects
    await runtimeStore.create(
      projects.find(({ id }) => id === 'project-a')!,
      'manual'
    )
    await runtimeStore.create(
      projects.find(({ id }) => id === 'project-b')!,
      'manual'
    )
    const starts: string[] = []
    const scheduler = new ProjectScheduler(
      projectStore,
      runtimeStore,
      {
        startRuntime: async (envelope) => {
          starts.push(envelope.runtime.projectId)
          await runtimeStore.transition(envelope.runtime.runtimeId, 'starting')
          await runtimeStore.transition(envelope.runtime.runtimeId, 'running')
        },
        timeoutRuntime: async () => undefined
      },
      { maxConcurrent: 1, tickIntervalMs: null, now: () => now }
    )

    await scheduler.start()
    expect(starts).toEqual(['project-b'])
    expect(await scheduler.getSnapshot()).toMatchObject({
      maxConcurrent: 1,
      executing: 1,
      queued: 1
    })

    const running = (await runtimeStore.read()).runtimes.find(
      ({ runtime }) => runtime.projectId === 'project-b'
    )!
    const terminal = (
      await runtimeStore.transition(running.runtime.runtimeId, 'completed')
    ).runtime
    scheduler.notifyRuntimeTerminal(terminal)
    await scheduler.tick()

    expect(starts).toEqual(['project-b', 'project-a'])
    scheduler.dispose()
  })

  it('serializes projects sharing a Profile while filling other slots', async () => {
    const sharedLow = createDraft('shared-low', 'manual', 0)
    const sharedHigh = createDraft('shared-high', 'manual', 10)
    sharedLow.profileId = 'shared-profile'
    sharedHigh.profileId = 'shared-profile'
    await projectStore.save(sharedLow)
    await projectStore.save(sharedHigh)
    await projectStore.save(createDraft('independent', 'manual', 5))
    const projects = (await projectStore.read()).projects
    for (const project of projects) {
      await runtimeStore.create(project, 'manual')
    }
    const starts: string[] = []
    const scheduler = new ProjectScheduler(
      projectStore,
      runtimeStore,
      {
        startRuntime: async (envelope) => {
          starts.push(envelope.runtime.projectId)
          await runtimeStore.transition(envelope.runtime.runtimeId, 'starting')
          await runtimeStore.transition(envelope.runtime.runtimeId, 'running')
        },
        timeoutRuntime: async () => undefined
      },
      { maxConcurrent: 2, tickIntervalMs: null, now: () => now }
    )

    await scheduler.start()
    expect(starts).toEqual(['shared-high', 'independent'])

    const high = (await runtimeStore.read()).runtimes.find(
      ({ runtime }) => runtime.projectId === 'shared-high'
    )!
    const terminal = (
      await runtimeStore.transition(high.runtime.runtimeId, 'completed')
    ).runtime
    scheduler.notifyRuntimeTerminal(terminal)
    await scheduler.tick()
    expect(starts).toEqual(['shared-high', 'independent', 'shared-low'])
    scheduler.dispose()
  })

  it('keeps a manual-takeover browser in the slot and Profile lock', async () => {
    const first = createDraft('takeover', 'manual', 10)
    first.profileId = 'shared-profile'
    const queued = createDraft('queued-shared', 'manual', 8)
    queued.profileId = 'shared-profile'
    await projectStore.save(first)
    await projectStore.save(createDraft('independent', 'manual', 9))
    await projectStore.save(queued)
    for (const project of (await projectStore.read()).projects) {
      await runtimeStore.create(project, 'manual')
    }
    const starts: string[] = []
    const scheduler = new ProjectScheduler(
      projectStore,
      runtimeStore,
      {
        startRuntime: async (envelope) => {
          starts.push(envelope.runtime.projectId)
          await runtimeStore.transition(envelope.runtime.runtimeId, 'starting')
          await runtimeStore.transition(envelope.runtime.runtimeId, 'waiting')
        },
        timeoutRuntime: async () => undefined
      },
      { maxConcurrent: 2, tickIntervalMs: null, now: () => now }
    )

    await scheduler.start()
    const takeover = (await runtimeStore.read()).runtimes.find(
      ({ runtime }) => runtime.projectId === 'takeover'
    )!
    scheduler.holdPausedRuntime(takeover.runtime.runtimeId)
    await runtimeStore.transition(takeover.runtime.runtimeId, 'paused')
    await scheduler.tick()

    expect(starts).toEqual(['takeover', 'independent'])
    expect(await scheduler.getSnapshot()).toMatchObject({
      executing: 2,
      queued: 1
    })

    const stopped = (
      await runtimeStore.transition(takeover.runtime.runtimeId, 'cancelled')
    ).runtime
    scheduler.notifyRuntimeTerminal(stopped)
    await scheduler.tick()
    expect(starts).toEqual(['takeover', 'independent', 'queued-shared'])
    scheduler.dispose()
  })

  it('requeues a cold paused runtime with the resume trigger', async () => {
    await projectStore.save(createDraft('paused-project', 'manual'))
    const project = (await projectStore.read()).projects[0]!
    const created = await runtimeStore.create(project, 'manual')
    await runtimeStore.transition(created.runtime.runtimeId, 'starting')
    await runtimeStore.transition(created.runtime.runtimeId, 'waiting')
    await runtimeStore.transition(created.runtime.runtimeId, 'paused')
    const starts: ProjectRuntimeEnvelope[] = []
    const scheduler = new ProjectScheduler(
      projectStore,
      runtimeStore,
      {
        startRuntime: async (envelope) => {
          starts.push(envelope)
          await runtimeStore.transition(envelope.runtime.runtimeId, 'starting')
          await runtimeStore.transition(envelope.runtime.runtimeId, 'running')
        },
        timeoutRuntime: async () => undefined
      },
      { tickIntervalMs: null, now: () => now }
    )

    await scheduler.start()
    expect(starts).toHaveLength(0)
    await scheduler.requestResume(project.id)
    expect(starts).toHaveLength(1)
    expect(starts[0]?.runtime.trigger).toBe('resume')
    scheduler.dispose()
  })

  it('creates autostart, resident, and due scheduled runtimes', async () => {
    await projectStore.save(createDraft('autostart-project', 'autostart'))
    await projectStore.save(createDraft('resident-project', 'resident'))
    await projectStore.save(
      createDraft('scheduled-project', 'schedule', 0, {
        kind: 'interval',
        everyMinutes: 1
      })
    )
    const scheduled = (await projectStore.read()).projects.find(
      ({ id }) => id === 'scheduled-project'
    )!
    now = Date.parse(scheduled.updatedAt) + 60_000
    const starts: Array<{ projectId: string; trigger: string }> = []
    const scheduler = new ProjectScheduler(
      projectStore,
      runtimeStore,
      {
        startRuntime: async (envelope) => {
          starts.push({
            projectId: envelope.runtime.projectId,
            trigger: envelope.runtime.trigger
          })
          await runtimeStore.transition(envelope.runtime.runtimeId, 'starting')
          await runtimeStore.transition(envelope.runtime.runtimeId, 'running')
        },
        timeoutRuntime: async () => undefined
      },
      { maxConcurrent: 3, tickIntervalMs: null, now: () => now }
    )

    await scheduler.start()

    expect(starts).toEqual(
      expect.arrayContaining([
        { projectId: 'autostart-project', trigger: 'autostart' },
        { projectId: 'resident-project', trigger: 'resident' },
        { projectId: 'scheduled-project', trigger: 'schedule' }
      ])
    )
    scheduler.dispose()
  })

  it('does not launch autostart again after resuming an interrupted run', async () => {
    await projectStore.save(createDraft('autostart-project', 'autostart'))
    const project = (await projectStore.read()).projects[0]!
    const interrupted = await runtimeStore.create(project, 'autostart')
    await runtimeStore.transition(interrupted.runtime.runtimeId, 'starting')
    await runtimeStore.transition(interrupted.runtime.runtimeId, 'running')
    await runtimeStore.recoverInterrupted()
    const starts: ProjectRuntimeEnvelope[] = []
    const scheduler = new ProjectScheduler(
      projectStore,
      runtimeStore,
      {
        startRuntime: async (envelope) => {
          starts.push(envelope)
          await runtimeStore.transition(envelope.runtime.runtimeId, 'starting')
          await runtimeStore.transition(envelope.runtime.runtimeId, 'running')
        },
        timeoutRuntime: async () => undefined
      },
      { tickIntervalMs: null, now: () => now }
    )

    await scheduler.start()
    const completed = (
      await runtimeStore.transition(starts[0]!.runtime.runtimeId, 'completed')
    ).runtime
    scheduler.notifyRuntimeTerminal(completed)
    await scheduler.tick()

    expect(starts).toHaveLength(1)
    expect(starts[0]?.runtime.trigger).toBe('resume')
    scheduler.dispose()
  })

  it('restarts a resident runtime only after its backoff', async () => {
    await projectStore.save(createDraft('resident-project', 'resident'))
    const starts: ProjectRuntimeEnvelope[] = []
    const scheduler = new ProjectScheduler(
      projectStore,
      runtimeStore,
      {
        startRuntime: async (envelope) => {
          starts.push(envelope)
          await runtimeStore.transition(envelope.runtime.runtimeId, 'starting')
          await runtimeStore.transition(envelope.runtime.runtimeId, 'running')
        },
        timeoutRuntime: async () => undefined
      },
      { tickIntervalMs: null, now: () => now }
    )
    await scheduler.start()
    const first = starts[0]!
    const failed = (
      await runtimeStore.transition(first.runtime.runtimeId, 'failed')
    ).runtime
    scheduler.notifyRuntimeTerminal(failed)

    await scheduler.tick()
    expect(starts).toHaveLength(1)
    now += 999
    await scheduler.tick()
    expect(starts).toHaveLength(1)
    now += 1
    await scheduler.tick()
    expect(starts).toHaveLength(2)
    expect(starts[1]?.runtime.trigger).toBe('resident')
    scheduler.dispose()
  })

  it('asks the host to stop a runtime that exceeds maxRunMs', async () => {
    await projectStore.save(createDraft('bounded-project', 'manual'))
    const timeoutRuntime = vi.fn(
      async (_envelope: ProjectRuntimeEnvelope, _reason: string) => undefined
    )
    const scheduler = new ProjectScheduler(
      projectStore,
      runtimeStore,
      {
        startRuntime: async (envelope) => {
          await runtimeStore.transition(envelope.runtime.runtimeId, 'starting')
          await runtimeStore.transition(envelope.runtime.runtimeId, 'running')
        },
        timeoutRuntime
      },
      { tickIntervalMs: null, now: () => now }
    )
    await scheduler.start()
    await scheduler.requestManual('bounded-project')
    now += 60_001

    await scheduler.tick()

    expect(timeoutRuntime).toHaveBeenCalledTimes(1)
    expect(timeoutRuntime.mock.calls[0]?.[1]).toContain('60000ms')
    scheduler.dispose()
  })

  it('retries timeout delivery when the host rejects it', async () => {
    await projectStore.save(createDraft('bounded-project', 'manual'))
    const timeoutRuntime = vi
      .fn<(envelope: ProjectRuntimeEnvelope, reason: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('host busy'))
      .mockResolvedValue(undefined)
    const scheduler = new ProjectScheduler(
      projectStore,
      runtimeStore,
      {
        startRuntime: async (envelope) => {
          await runtimeStore.transition(envelope.runtime.runtimeId, 'starting')
          await runtimeStore.transition(envelope.runtime.runtimeId, 'running')
        },
        timeoutRuntime
      },
      { tickIntervalMs: null, now: () => now }
    )
    await scheduler.start()
    await scheduler.requestManual('bounded-project')
    now += 60_001

    await scheduler.tick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await scheduler.tick()

    expect(timeoutRuntime).toHaveBeenCalledTimes(2)
    scheduler.dispose()
  })
})

describe('isProjectScheduleDue', () => {
  let temporaryRoot: string

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'agentic-schedule-test-'))
  })

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true })
  })

  it('uses the project timezone and does not repeat a daily occurrence', async () => {
    const projectStore = new ProjectStore(join(temporaryRoot, 'projects.json'))
    const runtimeStore = new ProjectRuntimeStore(
      join(temporaryRoot, 'runtimes.json'),
      () => Date.parse('2026-10-15T00:35:00.000Z'),
      () => 'dailyruntime'
    )
    await projectStore.save(
      createDraft('daily-project', 'schedule', 0, {
        kind: 'daily',
        times: ['08:30']
      })
    )
    const project = (await projectStore.read()).projects[0]!
    const now = Date.parse('2026-10-15T00:35:00.000Z')

    expect(isProjectScheduleDue(project, [], now)).toBe(true)
    const runtime = await runtimeStore.create(project, 'schedule')
    expect(isProjectScheduleDue(project, [runtime], now)).toBe(false)
  })
})

function createDraft(
  id: string,
  mode: ProjectRuntimeMode,
  priority = 0,
  schedule?: ProjectSchedule
): ProjectDraft {
  return {
    id,
    name: id,
    profileId: `${id}-profile`,
    startupPages: ['https://example.com/feed'],
    strategies: [],
    runtime: {
      mode,
      timezone: 'Asia/Shanghai',
      ...(schedule ? { schedule } : {}),
      priority,
      maxRunMs: 60_000
    },
    workflow: {
      version: 1,
      entryNodeId: 'wait',
      nodes: [
        {
          id: 'wait',
          kind: 'wait-for-event',
          eventName: 'project.finished',
          next: 'finished',
          timeoutMs: 60_000,
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
      root: join(temporaryRootForDrafts(), id),
      maxBytes: 1024 * 1024,
      fileNameTemplate: '{fileName}'
    },
    capabilities: createCapabilityPolicy(),
    filter: {
      enabled: false,
      networkRules: [],
      cssRules: []
    },
    retry: {
      maxConsecutiveFailures: 3,
      baseBackoffMs: 1_000,
      maxBackoffMs: 30_000
    },
    enabled: true
  }
}

function temporaryRootForDrafts(): string {
  return join(tmpdir(), 'agentic-scheduler-output')
}
