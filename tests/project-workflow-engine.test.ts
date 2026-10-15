import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createCapabilityPolicy } from '../src/main/capability-store'
import { ProjectRuntimeStore } from '../src/main/project-runtime-store'
import { ProjectStore } from '../src/main/project-store'
import {
  ProjectWorkflowEngine,
  type ProjectWorkflowHost
} from '../src/main/project-workflow-engine'
import type {
  ProjectDefinition,
  ProjectDraft,
  WorkflowNode
} from '../src/shared/contracts'

describe('ProjectWorkflowEngine', () => {
  let temporaryRoot: string
  let now: number
  let sequence: number
  let runtimeStore: ProjectRuntimeStore

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'agentic-workflow-test-'))
    now = Date.parse('2026-10-15T00:00:00.000Z')
    sequence = 0
    runtimeStore = new ProjectRuntimeStore(
      join(temporaryRoot, 'runtimes.json'),
      () => now,
      () => `workflow${++sequence}`
    )
  })

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true })
  })

  it('completes a workflow whose entry node is complete', async () => {
    const project = await createProject([
      node({ id: 'finished', kind: 'complete', checkpoint: true })
    ], temporaryRoot)
    const envelope = await runtimeStore.create(project, 'manual')
    const engine = new ProjectWorkflowEngine(
      envelope.runtime.runtimeId,
      runtimeStore,
      host(),
      () => now
    )

    expect(await engine.start()).toMatchObject({
      status: 'completed',
      currentNodeId: 'finished',
      checkpointNodeId: 'finished'
    })
  })

  it('navigates, checkpoints, waits for a domain event, and completes', async () => {
    const project = await createProject([
      node({
        id: 'open-feed',
        kind: 'navigate',
        url: 'https://example.com/feed',
        next: 'scan-complete',
        checkpoint: true
      }),
      node({
        id: 'scan-complete',
        kind: 'wait-for-event',
        eventName: 'feed.scan-complete',
        next: 'finished',
        checkpoint: true
      }),
      node({ id: 'finished', kind: 'complete', checkpoint: true })
    ], temporaryRoot)
    const envelope = await runtimeStore.create(project, 'manual')
    const navigate = vi.fn(async () => undefined)
    const changes: string[] = []
    const engine = new ProjectWorkflowEngine(
      envelope.runtime.runtimeId,
      runtimeStore,
      {
        navigate,
        onRuntimeChanged: (runtime) => changes.push(runtime.status)
      },
      () => now
    )

    const waiting = await engine.start()
    expect(navigate).toHaveBeenCalledWith(
      'https://example.com/feed',
      expect.any(AbortSignal)
    )
    expect(waiting).toMatchObject({
      status: 'waiting',
      currentNodeId: 'scan-complete',
      checkpointNodeId: 'scan-complete'
    })

    const completed = await engine.handleEvent({
      name: 'feed.scan-complete',
      payload: { postId: 'post-42' }
    })
    expect(completed).toMatchObject({
      status: 'completed',
      currentNodeId: 'finished',
      checkpointData: {
        lastEvent: {
          name: 'feed.scan-complete',
          payload: { postId: 'post-42' }
        }
      }
    })
    expect(changes).toContain('completed')
  })

  it('uses main-process time for delay nodes', async () => {
    const project = await createProject([
      node({
        id: 'pause',
        kind: 'delay',
        delayMs: 5_000,
        next: 'finished'
      }),
      node({ id: 'finished', kind: 'complete' })
    ], temporaryRoot)
    const envelope = await runtimeStore.create(project, 'manual')
    const engine = new ProjectWorkflowEngine(
      envelope.runtime.runtimeId,
      runtimeStore,
      host(),
      () => now
    )

    expect(await engine.start()).toMatchObject({
      status: 'waiting',
      nextWakeAt: '2026-10-15T00:00:05.000Z'
    })
    now += 4_999
    expect((await engine.tick()).status).toBe('waiting')
    now += 1
    expect((await engine.tick()).status).toBe('completed')
  })

  it('freezes workflow deadlines during manual takeover', async () => {
    const project = await createProject([
      node({
        id: 'pause',
        kind: 'delay',
        delayMs: 5_000,
        next: 'finished'
      }),
      node({ id: 'finished', kind: 'complete' })
    ], temporaryRoot)
    const envelope = await runtimeStore.create(project, 'manual')
    const engine = new ProjectWorkflowEngine(
      envelope.runtime.runtimeId,
      runtimeStore,
      host(),
      () => now
    )

    await engine.start()
    now += 2_000
    expect(
      await engine.pause(
        '测试站点登录失效',
        'authentication'
      )
    ).toMatchObject({
      status: 'paused',
      nextWakeAt: null,
      lastError: '测试站点登录失效',
      lastFailureCategory: 'authentication'
    })
    now += 60_000
    expect((await engine.tick()).status).toBe('paused')
    expect(await engine.resume()).toMatchObject({
      status: 'waiting',
      nextWakeAt: '2026-10-15T00:01:05.000Z',
      lastError: null,
      lastFailureCategory: null
    })
    now += 2_999
    expect((await engine.tick()).status).toBe('waiting')
    now += 1
    expect((await engine.tick()).status).toBe('completed')
  })

  it('does not consume domain events while paused', async () => {
    const project = await createProject([
      node({
        id: 'approval',
        kind: 'wait-for-event',
        eventName: 'human.approved',
        next: 'finished'
      }),
      node({ id: 'finished', kind: 'complete' })
    ], temporaryRoot)
    const envelope = await runtimeStore.create(project, 'manual')
    const engine = new ProjectWorkflowEngine(
      envelope.runtime.runtimeId,
      runtimeStore,
      host(),
      () => now
    )

    await engine.start()
    await engine.pause()
    expect(
      (
        await engine.handleEvent({
          name: 'human.approved'
        })
      ).status
    ).toBe('paused')
    await engine.resume()
    expect(
      (
        await engine.handleEvent({
          name: 'human.approved'
        })
      ).status
    ).toBe('completed')
  })

  it('retries classified failures with exponential backoff then opens the workflow circuit', async () => {
    const project = await createProject([
      node({
        id: 'open-feed',
        kind: 'navigate',
        url: 'https://example.com/feed',
        next: 'finished',
        maxAttempts: 2
      }),
      node({ id: 'finished', kind: 'complete' })
    ], temporaryRoot)
    const envelope = await runtimeStore.create(project, 'manual')
    const navigate = vi.fn(async () => {
      throw new Error('network disconnected')
    })
    const engine = new ProjectWorkflowEngine(
      envelope.runtime.runtimeId,
      runtimeStore,
      { navigate },
      () => now
    )

    const retry = await engine.start()
    expect(retry).toMatchObject({
      status: 'waiting',
      nodeAttempt: 1,
      lastFailureCategory: 'network',
      nextWakeAt: '2026-10-15T00:00:01.000Z'
    })
    now += 1_000
    const failed = await engine.tick()
    expect(failed).toMatchObject({
      status: 'failed',
      nodeAttempt: 2,
      lastFailureCategory: 'network',
      counters: { failed: 1 }
    })
    expect(navigate).toHaveBeenCalledTimes(2)
  })

  it('skips an already committed idempotency key after restart', async () => {
    const project = await createProject([
      node({
        id: 'download',
        kind: 'navigate',
        url: 'https://example.com/download',
        next: 'finished',
        idempotencyKey: 'post-1:attachment-1'
      }),
      node({ id: 'finished', kind: 'complete' })
    ], temporaryRoot)
    const envelope = await runtimeStore.create(project, 'manual')
    await runtimeStore.completeIdempotency({
      key: 'post-1:attachment-1',
      projectId: project.id,
      runtimeId: envelope.runtime.runtimeId,
      workflowNodeId: 'download',
      result: { finalPath: 'meeting.mp3' }
    })
    const navigate = vi.fn(async () => undefined)
    const engine = new ProjectWorkflowEngine(
      envelope.runtime.runtimeId,
      runtimeStore,
      { navigate },
      () => now
    )

    expect((await engine.start()).status).toBe('completed')
    expect(navigate).not.toHaveBeenCalled()
  })

  it('takes an explicit failure transition before exhausting retries', async () => {
    const project = await createProject([
      node({
        id: 'open-feed',
        kind: 'navigate',
        url: 'https://example.com/feed',
        next: 'finished',
        onFailure: { authentication: 'login-required' }
      }),
      node({
        id: 'login-required',
        kind: 'wait-for-event',
        eventName: 'auth.login-restored',
        next: 'finished'
      }),
      node({ id: 'finished', kind: 'complete' })
    ], temporaryRoot)
    const envelope = await runtimeStore.create(project, 'manual')
    const engine = new ProjectWorkflowEngine(
      envelope.runtime.runtimeId,
      runtimeStore,
      {
        navigate: async () => {
          throw new Error('login required')
        }
      },
      () => now
    )

    expect(await engine.start()).toMatchObject({
      status: 'waiting',
      currentNodeId: 'login-required'
    })
  })
})

function host(): ProjectWorkflowHost {
  return { navigate: async () => undefined }
}

type WorkflowNodeInput<T extends WorkflowNode = WorkflowNode> =
  T extends WorkflowNode
    ? Omit<T, 'timeoutMs' | 'maxAttempts' | 'checkpoint'> &
        Partial<Pick<T, 'timeoutMs' | 'maxAttempts' | 'checkpoint'>>
    : never

function node(value: WorkflowNodeInput): WorkflowNode {
  return {
    timeoutMs: 10_000,
    maxAttempts: 3,
    checkpoint: false,
    ...value
  } as WorkflowNode
}

async function createProject(
  nodes: WorkflowNode[],
  root: string
): Promise<ProjectDefinition> {
  const store = new ProjectStore(
    join(root, `project-${Math.random()}.json`)
  )
  const draft: ProjectDraft = {
    id: 'workflow-project',
    name: 'Workflow Project',
    profileId: 'profile-default',
    startupPages: ['https://example.com/feed'],
    strategies: [],
    runtime: {
      mode: 'manual',
      timezone: 'Asia/Shanghai',
      priority: 0,
      maxRunMs: 60_000
    },
    workflow: {
      version: 1,
      entryNodeId: nodes[0]!.id,
      nodes
    },
    output: {
      root: join(root, 'output'),
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
      maxBackoffMs: 10_000
    },
    enabled: true
  }
  return (await store.save(draft)).projects[0]!
}
