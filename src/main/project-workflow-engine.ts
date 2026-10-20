import type {
  JsonValue,
  ProjectDefinition,
  ProjectRuntimeRecord,
  WorkflowFailureCategory,
  WorkflowNode
} from '../shared/contracts'
import type {
  ProjectRuntimeStore,
  ProjectRuntimeEnvelope
} from './project-runtime-store'

export interface ProjectWorkflowHost {
  navigate(url: string, signal: AbortSignal): Promise<void>
  onRuntimeChanged?(runtime: ProjectRuntimeRecord): void
}

export interface ProjectWorkflowEvent {
  name: string
  payload?: JsonValue
}

export class ProjectWorkflowEngine {
  private queue = Promise.resolve()
  private disposed = false
  private pausedState: {
    status: 'waiting'
    remainingWakeMs: number | null
  } | null = null

  constructor(
    readonly runtimeId: string,
    private readonly store: ProjectRuntimeStore,
    private readonly host: ProjectWorkflowHost,
    private readonly now: () => number = Date.now
  ) {}

  start(): Promise<ProjectRuntimeRecord> {
    return this.enqueue(async () => {
      const envelope = await this.requireEnvelope()
      if (envelope.runtime.status !== 'queued') {
        throw new Error(
          `Workflow 只能从 queued 启动，实际为 ${envelope.runtime.status}`
        )
      }
      await this.transition('starting', {
        lastError: null,
        lastFailureCategory: null,
        nextWakeAt: null
      })
      return this.advance()
    })
  }

  handleEvent(event: ProjectWorkflowEvent): Promise<ProjectRuntimeRecord> {
    return this.enqueue(async () => {
      validateEvent(event)
      const envelope = await this.requireEnvelope()
      const node = requireNode(envelope)
      if (
        envelope.runtime.status !== 'waiting' ||
        node.kind !== 'wait-for-event' ||
        node.eventName !== event.name
      ) {
        return envelope.runtime
      }
      return this.completeNode(envelope, node, {
        lastEvent: {
          name: event.name,
          ...(event.payload === undefined
            ? {}
            : { payload: structuredClone(event.payload) })
        }
      })
    })
  }

  tick(): Promise<ProjectRuntimeRecord> {
    return this.enqueue(async () => {
      const envelope = await this.requireEnvelope()
      if (
        envelope.runtime.status !== 'waiting' ||
        envelope.runtime.nextWakeAt === null ||
        Date.parse(envelope.runtime.nextWakeAt) > this.now()
      ) {
        return envelope.runtime
      }

      const node = requireNode(envelope)
      if (envelope.runtime.lastFailureCategory !== null) {
        await this.transition('running', {
          nextWakeAt: null,
          lastError: null,
          lastFailureCategory: null
        })
        return this.advance()
      }
      if (node.kind === 'delay') {
        return this.completeNode(envelope, node)
      }
      if (node.kind === 'wait-for-event') {
        return this.handleNodeFailure(
          envelope,
          node,
          'timeout',
          `等待领域事件 ${node.eventName} 超时`
        )
      }
      return envelope.runtime
    })
  }

  pause(
    reason: string | null = null,
    category: WorkflowFailureCategory | null = null
  ): Promise<ProjectRuntimeRecord> {
    return this.enqueue(async () => {
      const envelope = await this.requireEnvelope()
      if (
        envelope.runtime.status === 'failed' ||
        envelope.runtime.status === 'completed' ||
        envelope.runtime.status === 'cancelled' ||
        envelope.runtime.status === 'paused'
      ) {
        return envelope.runtime
      }
      if (envelope.runtime.status !== 'waiting') {
        throw new Error(
          `Workflow 只能在稳定等待态暂停，实际为 ${envelope.runtime.status}`
        )
      }
      this.pausedState = {
        status: 'waiting',
        remainingWakeMs:
          envelope.runtime.nextWakeAt === null
            ? null
            : Math.max(0, Date.parse(envelope.runtime.nextWakeAt) - this.now())
      }
      const paused = await this.transition('paused', {
        nextWakeAt: null,
        lastError: reason === null ? null : truncate(reason, 4_000),
        lastFailureCategory: category
      })
      return paused.runtime
    })
  }

  resume(): Promise<ProjectRuntimeRecord> {
    return this.enqueue(async () => {
      const envelope = await this.requireEnvelope()
      if (envelope.runtime.status !== 'paused') {
        throw new Error(
          `Workflow 只能从 paused 恢复，实际为 ${envelope.runtime.status}`
        )
      }
      if (!this.pausedState) {
        throw new Error('Workflow 的进程内暂停状态不可用')
      }
      const pausedState = this.pausedState
      const resumed = await this.transition(pausedState.status, {
        nextWakeAt:
          pausedState.remainingWakeMs === null
            ? null
            : new Date(this.now() + pausedState.remainingWakeMs).toISOString(),
        lastError: null,
        lastFailureCategory: null
      })
      this.pausedState = null
      return resumed.runtime
    })
  }

  cancel(reason = '用户停止 Project Runtime'): Promise<ProjectRuntimeRecord> {
    return this.enqueue(async () => {
      const envelope = await this.requireEnvelope()
      if (
        envelope.runtime.status === 'failed' ||
        envelope.runtime.status === 'completed' ||
        envelope.runtime.status === 'cancelled'
      ) {
        return envelope.runtime
      }
      const next = await this.transition('cancelled', {
        lastError: truncate(reason, 4_000),
        lastFailureCategory: 'cancelled',
        nextWakeAt: null
      })
      this.pausedState = null
      this.disposed = true
      return next.runtime
    })
  }

  fail(
    category: WorkflowFailureCategory,
    reason: string
  ): Promise<ProjectRuntimeRecord> {
    return this.enqueue(async () => {
      const envelope = await this.requireEnvelope()
      if (
        envelope.runtime.status === 'failed' ||
        envelope.runtime.status === 'completed' ||
        envelope.runtime.status === 'cancelled'
      ) {
        return envelope.runtime
      }
      const next = await this.transition('failed', {
        lastError: truncate(reason, 4_000),
        lastFailureCategory: category,
        counters: { failed: 1 },
        nextWakeAt: null
      })
      this.pausedState = null
      this.disposed = true
      return next.runtime
    })
  }

  private async advance(): Promise<ProjectRuntimeRecord> {
    for (let step = 0; step < 128; step += 1) {
      this.assertActive()
      const envelope = await this.requireEnvelope()
      const node = requireNode(envelope)

      if (node.kind === 'complete') {
        const completed = await this.transition('completed', {
          checkpointNodeId: node.checkpoint
            ? node.id
            : envelope.runtime.checkpointNodeId,
          nextWakeAt: null,
          lastError: null,
          lastFailureCategory: null
        })
        return completed.runtime
      }

      const key = node.idempotencyKey
        ? resolveIdempotencyKey(
            node.idempotencyKey,
            envelope.runtime.checkpointData
          )
        : null
      if (
        key &&
        (await this.store.findIdempotency(envelope.runtime.projectId, key))
      ) {
        await this.moveToNext(envelope, node)
        continue
      }

      if (node.kind === 'delay') {
        const waiting = await this.transition('waiting', {
          nodeAttempt: envelope.runtime.nodeAttempt + 1,
          nextWakeAt: new Date(this.now() + node.delayMs).toISOString(),
          lastError: null,
          lastFailureCategory: null
        })
        return waiting.runtime
      }

      if (node.kind === 'wait-for-event') {
        const waiting = await this.transition('waiting', {
          nodeAttempt: envelope.runtime.nodeAttempt + 1,
          nextWakeAt: new Date(this.now() + node.timeoutMs).toISOString(),
          lastError: null,
          lastFailureCategory: null
        })
        return waiting.runtime
      }

      const running = await this.transition(
        envelope.runtime.status === 'starting'
          ? 'running'
          : envelope.runtime.status,
        {
          nodeAttempt: envelope.runtime.nodeAttempt + 1,
          nextWakeAt: null,
          lastError: null,
          lastFailureCategory: null
        }
      )
      try {
        await withTimeout(
          (signal) => this.host.navigate(node.url, signal),
          node.timeoutMs,
          `导航 ${node.url} 超时`
        )
        return this.completeNode(running, node)
      } catch (error) {
        const category = classifyWorkflowError(error)
        return this.handleNodeFailure(
          running,
          node,
          category,
          error instanceof Error ? error.message : String(error)
        )
      }
    }

    const failed = await this.transition('failed', {
      lastError: 'Workflow 在单次推进中超过 128 个同步节点',
      lastFailureCategory: 'unknown'
    })
    return failed.runtime
  }

  private async completeNode(
    envelope: ProjectRuntimeEnvelope,
    node: Exclude<WorkflowNode, { kind: 'complete' }>,
    checkpointPatch: Record<string, JsonValue> = {}
  ): Promise<ProjectRuntimeRecord> {
    const checkpointData = {
      ...envelope.runtime.checkpointData,
      ...structuredClone(checkpointPatch)
    }
    if (node.idempotencyKey) {
      const key = resolveIdempotencyKey(node.idempotencyKey, checkpointData)
      await this.store.completeIdempotency({
        key,
        projectId: envelope.runtime.projectId,
        runtimeId: envelope.runtime.runtimeId,
        workflowNodeId: node.id,
        result: checkpointPatch
      })
    }
    await this.moveToNext(envelope, node, checkpointData)
    return this.advance()
  }

  private async moveToNext(
    envelope: ProjectRuntimeEnvelope,
    node: Exclude<WorkflowNode, { kind: 'complete' }>,
    checkpointData = envelope.runtime.checkpointData
  ): Promise<ProjectRuntimeEnvelope> {
    return this.transition('running', {
      currentNodeId: node.next,
      nodeAttempt: 0,
      checkpointNodeId: node.checkpoint
        ? node.next
        : envelope.runtime.checkpointNodeId,
      checkpointData,
      nextWakeAt: null,
      lastError: null,
      lastFailureCategory: null
    })
  }

  private async handleNodeFailure(
    envelope: ProjectRuntimeEnvelope,
    node: WorkflowNode,
    category: WorkflowFailureCategory,
    reason: string
  ): Promise<ProjectRuntimeRecord> {
    const detail = truncate(reason, 4_000)
    const transition = node.onFailure?.[category] ?? node.onFailure?.unknown
    if (transition) {
      await this.transition('recovering', {
        lastError: detail,
        lastFailureCategory: category
      })
      const moved = await this.transition('running', {
        currentNodeId: transition,
        nodeAttempt: 0,
        nextWakeAt: null
      })
      return this.advanceFrom(moved)
    }

    if (envelope.runtime.nodeAttempt < node.maxAttempts) {
      await this.transition('recovering', {
        lastError: detail,
        lastFailureCategory: category
      })
      const delay = retryDelay(
        envelope.projectSnapshot,
        envelope.runtime.nodeAttempt
      )
      const waiting = await this.transition('waiting', {
        nextWakeAt: new Date(this.now() + delay).toISOString(),
        lastError: detail,
        lastFailureCategory: category
      })
      return waiting.runtime
    }

    const failed = await this.transition('failed', {
      lastError: detail,
      lastFailureCategory: category,
      counters: { failed: 1 },
      nextWakeAt: null
    })
    return failed.runtime
  }

  private advanceFrom(
    _envelope: ProjectRuntimeEnvelope
  ): Promise<ProjectRuntimeRecord> {
    return this.advance()
  }

  private async transition(
    status: ProjectRuntimeRecord['status'],
    patch: Parameters<ProjectRuntimeStore['transition']>[2]
  ): Promise<ProjectRuntimeEnvelope> {
    const envelope = await this.store.transition(this.runtimeId, status, patch)
    this.host.onRuntimeChanged?.(structuredClone(envelope.runtime))
    return envelope
  }

  private async requireEnvelope(): Promise<ProjectRuntimeEnvelope> {
    const state = await this.store.read()
    const envelope = state.runtimes.find(
      ({ runtime }) => runtime.runtimeId === this.runtimeId
    )
    if (!envelope) {
      throw new Error(`Project Runtime 不存在：${this.runtimeId}`)
    }
    return structuredClone(envelope)
  }

  private enqueue(
    operation: () => Promise<ProjectRuntimeRecord>
  ): Promise<ProjectRuntimeRecord> {
    const pending = this.queue.then(operation)
    this.queue = pending.then(
      () => undefined,
      () => undefined
    )
    return pending
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error('Workflow Engine 已停止')
    }
  }
}

function requireNode(envelope: ProjectRuntimeEnvelope): WorkflowNode {
  const node = envelope.projectSnapshot.workflow.nodes.find(
    (candidate) => candidate.id === envelope.runtime.currentNodeId
  )
  if (!node) {
    throw new Error(`Workflow 节点不存在：${envelope.runtime.currentNodeId}`)
  }
  return node
}

function resolveIdempotencyKey(
  template: string,
  data: Record<string, JsonValue>
): string {
  const key = template.replace(
    /\{([a-zA-Z][a-zA-Z0-9_.-]{0,79})\}/g,
    (_match, path: string) => {
      const value = readJsonPath(data, path)
      if (
        typeof value !== 'string' &&
        typeof value !== 'number' &&
        typeof value !== 'boolean'
      ) {
        throw new Error(`幂等键变量缺失或不是标量：${path}`)
      }
      return String(value)
    }
  )
  if (key.length === 0 || key.length > 500 || key.includes('{')) {
    throw new Error('解析后的幂等键无效')
  }
  return key
}

function readJsonPath(
  value: Record<string, JsonValue>,
  path: string
): JsonValue | undefined {
  let current: JsonValue | undefined = value
  for (const segment of path.split('.')) {
    if (
      current === null ||
      typeof current !== 'object' ||
      Array.isArray(current)
    ) {
      return undefined
    }
    current = current[segment]
  }
  return current
}

function retryDelay(project: ProjectDefinition, attempt: number): number {
  return Math.min(
    project.retry.maxBackoffMs,
    project.retry.baseBackoffMs * 2 ** Math.max(0, attempt - 1)
  )
}

function classifyWorkflowError(error: unknown): WorkflowFailureCategory {
  if (error instanceof WorkflowTimeoutError) {
    return 'timeout'
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase()
    if (
      message.includes('disk') ||
      message.includes('enospc') ||
      message.includes('磁盘')
    ) {
      return 'disk'
    }
    if (
      message.includes('auth') ||
      message.includes('login') ||
      message.includes('登录')
    ) {
      return 'authentication'
    }
    if (message.includes('renderer') || message.includes('render process')) {
      return 'renderer'
    }
    if (
      message.includes('network') ||
      message.includes('net::') ||
      message.includes('网络')
    ) {
      return 'network'
    }
  }
  return 'unknown'
}

class WorkflowTimeoutError extends Error {}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  const controller = new AbortController()
  let timer: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new WorkflowTimeoutError(message))
        }, timeoutMs)
        timer.unref()
      })
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

function validateEvent(event: ProjectWorkflowEvent): void {
  if (
    !/^[a-z][a-z0-9.-]{0,79}$/.test(event.name) ||
    (event.payload !== undefined &&
      Buffer.byteLength(JSON.stringify(event.payload), 'utf8') > 128 * 1024)
  ) {
    throw new Error('Workflow 领域事件格式无效')
  }
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`
}
