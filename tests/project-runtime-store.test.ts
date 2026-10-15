import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createCapabilityPolicy } from '../src/main/capability-store'
import { ProjectStore } from '../src/main/project-store'
import {
  ProjectRuntimeStore,
  parseProjectRuntimeState
} from '../src/main/project-runtime-store'
import type { ProjectDefinition, ProjectDraft } from '../src/shared/contracts'

describe('ProjectRuntimeStore', () => {
  let temporaryRoot: string
  let project: ProjectDefinition
  let now: number
  let sequence: number
  let store: ProjectRuntimeStore

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'agentic-runtime-test-'))
    const projectStore = new ProjectStore(
      join(temporaryRoot, 'projects.json')
    )
    project = (await projectStore.save(createProjectDraft())).projects[0]!
    now = Date.parse('2026-10-15T00:00:00.000Z')
    sequence = 0
    store = new ProjectRuntimeStore(
      join(temporaryRoot, 'runtimes.json'),
      () => now,
      () => `runtimeid${++sequence}`
    )
  })

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true })
  })

  it('persists a project snapshot and enforces state transitions', async () => {
    const created = await store.create(project, 'manual')
    expect(created.runtime).toMatchObject({
      status: 'queued',
      projectId: project.id,
      currentNodeId: 'open-feed'
    })
    expect(created.projectSnapshot).toEqual(project)

    await expect(
      store.transition(created.runtime.runtimeId, 'completed')
    ).rejects.toThrow('不能从 queued 转为 completed')

    now += 1_000
    await store.transition(created.runtime.runtimeId, 'starting')
    const running = await store.transition(
      created.runtime.runtimeId,
      'running',
      {
        currentNodeId: 'finished',
        nodeAttempt: 1,
        checkpointNodeId: 'finished',
        checkpointData: { cursor: 'post-42' },
        counters: { scanned: 5, matched: 2 }
      }
    )
    expect(running.runtime).toMatchObject({
      status: 'running',
      currentNodeId: 'finished',
      checkpointNodeId: 'finished',
      counters: { scanned: 5, matched: 2 }
    })

    now += 1_000
    const completed = await store.transition(
      created.runtime.runtimeId,
      'completed'
    )
    expect(completed.runtime.completedAt).toBe(
      '2026-10-15T00:00:02.000Z'
    )
  })

  it('enforces a project single-instance lock across persisted state', async () => {
    await store.create(project, 'manual')
    await expect(store.create(project, 'schedule')).rejects.toThrow(
      '已有活跃 Runtime'
    )
  })

  it('recovers interrupted runtimes from their last checkpoint', async () => {
    const created = await store.create(project, 'manual')
    await store.transition(created.runtime.runtimeId, 'starting')
    await store.transition(created.runtime.runtimeId, 'running', {
      currentNodeId: 'finished',
      checkpointNodeId: 'finished',
      checkpointData: { postId: 'post-1' }
    })

    now += 5_000
    const recovered = await store.recoverInterrupted()
    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.runtime).toMatchObject({
      trigger: 'resume',
      status: 'queued',
      currentNodeId: 'finished',
      checkpointData: { postId: 'post-1' }
    })
  })

  it('commits idempotency keys once across retries and restarts', async () => {
    const created = await store.create(project, 'manual')
    const record = {
      key: 'post-1:attachment-2',
      projectId: project.id,
      runtimeId: created.runtime.runtimeId,
      workflowNodeId: 'open-feed',
      result: { finalPath: 'meeting.mp3' }
    }
    const first = await store.completeIdempotency(record)
    now += 10_000
    const duplicate = await store.completeIdempotency({
      ...record,
      result: { finalPath: 'should-not-replace.mp3' }
    })
    expect(duplicate).toEqual(first)
    await expect(
      store.findIdempotency(project.id, record.key)
    ).resolves.toEqual(first)
  })

  it('rejects duplicate active projects in persisted data', async () => {
    const first = await store.create(project, 'manual')
    const state = await store.read()
    expect(
      parseProjectRuntimeState({
        ...state,
        runtimes: [
          first,
          {
            ...structuredClone(first),
            runtime: {
              ...first.runtime,
              runtimeId: 'runtime-anotherid'
            }
          }
        ]
      })
    ).toBeNull()
  })
})

function createProjectDraft(): ProjectDraft {
  return {
    id: 'knowledge-audio',
    name: '知识星球语音采集',
    profileId: 'profile-default',
    startupPages: ['https://example.com/feed'],
    strategies: [{ id: 'feed-scanner', version: '0.1.0' }],
    runtime: {
      mode: 'manual',
      timezone: 'Asia/Shanghai',
      priority: 0,
      maxRunMs: 60_000
    },
    workflow: {
      version: 1,
      entryNodeId: 'open-feed',
      nodes: [
        {
          id: 'open-feed',
          kind: 'navigate',
          url: 'https://example.com/feed',
          next: 'finished',
          timeoutMs: 10_000,
          maxAttempts: 3,
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
      root: join(tmpdir(), 'agentic-runtime-output'),
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
