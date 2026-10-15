import { randomUUID } from 'node:crypto'
import { rename } from 'node:fs/promises'

import type {
  JsonValue,
  ProjectDefinition,
  ProjectRuntimeCounters,
  ProjectRuntimeRecord,
  ProjectRuntimeStatus,
  WorkflowFailureCategory
} from '../shared/contracts'
import {
  isNodeError,
  readJsonFile,
  writeJsonAtomic
} from './atomic-file'
import { parseProjectDefinition } from './project-store'

export interface ProjectRuntimeEnvelope {
  runtime: ProjectRuntimeRecord
  projectSnapshot: ProjectDefinition
}

export interface ProjectIdempotencyRecord {
  key: string
  projectId: string
  runtimeId: string
  workflowNodeId: string
  result: JsonValue
  completedAt: string
}

export interface ProjectRuntimeState {
  schemaVersion: 1
  runtimes: ProjectRuntimeEnvelope[]
  idempotency: ProjectIdempotencyRecord[]
}

export interface RuntimeTransitionPatch {
  currentNodeId?: string
  nodeAttempt?: number
  checkpointNodeId?: string | null
  checkpointData?: Record<string, JsonValue>
  nextWakeAt?: string | null
  lastError?: string | null
  lastFailureCategory?: WorkflowFailureCategory | null
  counters?: Partial<ProjectRuntimeCounters>
}

const TERMINAL_STATUSES = new Set<ProjectRuntimeStatus>([
  'failed',
  'completed',
  'cancelled'
])
const INTERRUPTED_STATUSES = new Set<ProjectRuntimeStatus>([
  'starting',
  'running',
  'waiting',
  'recovering'
])
const TRANSITIONS: Record<ProjectRuntimeStatus, ReadonlySet<ProjectRuntimeStatus>> = {
  queued: new Set(['starting', 'paused', 'cancelled']),
  starting: new Set([
    'running',
    'waiting',
    'recovering',
    'failed',
    'completed',
    'cancelled'
  ]),
  running: new Set([
    'waiting',
    'recovering',
    'paused',
    'failed',
    'completed',
    'cancelled'
  ]),
  waiting: new Set([
    'running',
    'recovering',
    'paused',
    'failed',
    'completed',
    'cancelled'
  ]),
  recovering: new Set([
    'running',
    'waiting',
    'paused',
    'failed',
    'cancelled'
  ]),
  paused: new Set(['queued', 'waiting', 'failed', 'cancelled']),
  failed: new Set(),
  completed: new Set(),
  cancelled: new Set()
}
const EMPTY_COUNTERS: ProjectRuntimeCounters = {
  scanned: 0,
  matched: 0,
  skipped: 0,
  downloaded: 0,
  failed: 0,
  downloadedBytes: 0
}

export class ProjectRuntimeStore {
  private queue = Promise.resolve()

  constructor(
    readonly filePath: string,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = randomUUID
  ) {}

  async read(): Promise<ProjectRuntimeState> {
    let value: unknown | null
    try {
      value = await readJsonFile(this.filePath)
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error
      }
      await this.quarantineInvalidFile()
      return emptyRuntimeState()
    }

    if (value === null) {
      return emptyRuntimeState()
    }
    const state = parseProjectRuntimeState(value)
    if (state) {
      return state
    }
    await this.quarantineInvalidFile()
    return emptyRuntimeState()
  }

  async create(
    project: ProjectDefinition,
    trigger: ProjectRuntimeRecord['trigger']
  ): Promise<ProjectRuntimeEnvelope> {
    return this.update((state) => {
      if (
        state.runtimes.some(
          ({ runtime }) =>
            runtime.projectId === project.id &&
            !TERMINAL_STATUSES.has(runtime.status)
        )
      ) {
        throw new Error(`Project 已有活跃 Runtime：${project.id}`)
      }
      const now = new Date(this.now()).toISOString()
      const runtime: ProjectRuntimeRecord = {
        runtimeId: createRuntimeId(this.createId),
        projectId: project.id,
        projectRevision: project.revision,
        trigger,
        status: 'queued',
        currentNodeId: project.workflow.entryNodeId,
        nodeAttempt: 0,
        checkpointNodeId: null,
        checkpointData: {},
        lastHeartbeatAt: now,
        nextWakeAt: null,
        lastError: null,
        lastFailureCategory: null,
        counters: { ...EMPTY_COUNTERS },
        startedAt: now,
        updatedAt: now,
        completedAt: null
      }
      const envelope = {
        runtime,
        projectSnapshot: structuredClone(project)
      }
      return {
        state: {
          ...state,
          runtimes: pruneRuntimes([...state.runtimes, envelope])
        },
        result: envelope
      }
    })
  }

  async transition(
    runtimeId: string,
    status: ProjectRuntimeStatus,
    patch: RuntimeTransitionPatch = {}
  ): Promise<ProjectRuntimeEnvelope> {
    return this.update((state) => {
      const index = state.runtimes.findIndex(
        ({ runtime }) => runtime.runtimeId === runtimeId
      )
      if (index < 0) {
        throw new Error(`Project Runtime 不存在：${runtimeId}`)
      }
      const current = state.runtimes[index]!
      if (
        current.runtime.status !== status &&
        !TRANSITIONS[current.runtime.status].has(status)
      ) {
        throw new Error(
          `Project Runtime 状态不能从 ${current.runtime.status} 转为 ${status}`
        )
      }
      const updatedAt = new Date(this.now()).toISOString()
      const runtime = applyTransitionPatch(
        {
          ...current.runtime,
          status,
          lastHeartbeatAt: updatedAt,
          updatedAt,
          completedAt: TERMINAL_STATUSES.has(status)
            ? updatedAt
            : current.runtime.completedAt
        },
        patch
      )
      const envelope = {
        runtime,
        projectSnapshot: structuredClone(current.projectSnapshot)
      }
      const runtimes = [...state.runtimes]
      runtimes[index] = envelope
      return { state: { ...state, runtimes }, result: envelope }
    })
  }

  async heartbeat(runtimeId: string): Promise<ProjectRuntimeEnvelope> {
    return this.update((state) => {
      const index = state.runtimes.findIndex(
        ({ runtime }) => runtime.runtimeId === runtimeId
      )
      if (index < 0) {
        throw new Error(`Project Runtime 不存在：${runtimeId}`)
      }
      const current = state.runtimes[index]!
      if (TERMINAL_STATUSES.has(current.runtime.status)) {
        throw new Error('终态 Project Runtime 不能更新心跳')
      }
      const now = new Date(this.now()).toISOString()
      const envelope = {
        runtime: {
          ...current.runtime,
          lastHeartbeatAt: now,
          updatedAt: now
        },
        projectSnapshot: structuredClone(current.projectSnapshot)
      }
      const runtimes = [...state.runtimes]
      runtimes[index] = envelope
      return { state: { ...state, runtimes }, result: envelope }
    })
  }

  async incrementCounters(
    runtimeId: string,
    counters: Partial<ProjectRuntimeCounters>
  ): Promise<ProjectRuntimeEnvelope> {
    return this.update((state) => {
      const index = state.runtimes.findIndex(
        ({ runtime }) => runtime.runtimeId === runtimeId
      )
      if (index < 0) {
        throw new Error(`Project Runtime 不存在：${runtimeId}`)
      }
      const current = state.runtimes[index]!
      const updatedAt = new Date(this.now()).toISOString()
      const envelope = {
        runtime: applyTransitionPatch(
          {
            ...current.runtime,
            lastHeartbeatAt: updatedAt,
            updatedAt
          },
          { counters }
        ),
        projectSnapshot: structuredClone(current.projectSnapshot)
      }
      const runtimes = [...state.runtimes]
      runtimes[index] = envelope
      return { state: { ...state, runtimes }, result: envelope }
    })
  }

  async recoverInterrupted(): Promise<ProjectRuntimeEnvelope[]> {
    return this.update((state) => {
      const now = new Date(this.now()).toISOString()
      const recovered: ProjectRuntimeEnvelope[] = []
      const runtimes = state.runtimes.map((envelope) => {
        if (!INTERRUPTED_STATUSES.has(envelope.runtime.status)) {
          return envelope
        }
        const next: ProjectRuntimeEnvelope = {
          runtime: {
            ...envelope.runtime,
            trigger: 'resume',
            status: 'queued',
            nodeAttempt: 0,
            currentNodeId:
              envelope.runtime.checkpointNodeId ??
              envelope.projectSnapshot.workflow.entryNodeId,
            lastHeartbeatAt: now,
            updatedAt: now,
            nextWakeAt: null,
            lastError: '应用退出时 Runtime 未完成，已排队恢复',
            lastFailureCategory: 'unknown'
          },
          projectSnapshot: structuredClone(envelope.projectSnapshot)
        }
        recovered.push(next)
        return next
      })
      return {
        state: { ...state, runtimes },
        result: recovered
      }
    })
  }

  async resumePaused(runtimeId: string): Promise<ProjectRuntimeEnvelope> {
    return this.update((state) => {
      const index = state.runtimes.findIndex(
        ({ runtime }) => runtime.runtimeId === runtimeId
      )
      if (index < 0) {
        throw new Error(`Project Runtime 不存在：${runtimeId}`)
      }
      const current = state.runtimes[index]!
      if (current.runtime.status !== 'paused') {
        throw new Error(
          `只有 paused Runtime 可以恢复，实际为 ${current.runtime.status}`
        )
      }
      const now = new Date(this.now()).toISOString()
      const envelope: ProjectRuntimeEnvelope = {
        runtime: {
          ...current.runtime,
          trigger: 'resume',
          status: 'queued',
          nodeAttempt: 0,
          currentNodeId:
            current.runtime.checkpointNodeId ??
            current.projectSnapshot.workflow.entryNodeId,
          lastHeartbeatAt: now,
          updatedAt: now,
          nextWakeAt: null,
          lastError: '人工接管已结束，已从最近检查点排队恢复',
          lastFailureCategory: null
        },
        projectSnapshot: structuredClone(current.projectSnapshot)
      }
      const runtimes = [...state.runtimes]
      runtimes[index] = envelope
      return { state: { ...state, runtimes }, result: envelope }
    })
  }

  async completeIdempotency(
    record: Omit<ProjectIdempotencyRecord, 'completedAt'>
  ): Promise<ProjectIdempotencyRecord> {
    return this.update((state) => {
      validateIdempotencyRecordInput(record)
      const existing = state.idempotency.find(
        (candidate) =>
          candidate.projectId === record.projectId &&
          candidate.key === record.key
      )
      if (existing) {
        return { state, result: existing }
      }
      const completed: ProjectIdempotencyRecord = {
        ...structuredClone(record),
        completedAt: new Date(this.now()).toISOString()
      }
      return {
        state: {
          ...state,
          idempotency: [...state.idempotency, completed].slice(-10_000)
        },
        result: completed
      }
    })
  }

  async findIdempotency(
    projectId: string,
    key: string
  ): Promise<ProjectIdempotencyRecord | null> {
    const state = await this.read()
    const record = state.idempotency.find(
      (candidate) =>
        candidate.projectId === projectId && candidate.key === key
    )
    return record ? structuredClone(record) : null
  }

  private async update<T>(
    transform: (
      state: ProjectRuntimeState
    ) => { state: ProjectRuntimeState; result: T }
  ): Promise<T> {
    let result: T | undefined
    const operation = this.queue.then(async () => {
      const transformed = transform(await this.read())
      result = transformed.result
      await writeJsonAtomic(this.filePath, transformed.state)
    })
    this.queue = operation.catch(() => undefined)
    await operation
    return result!
  }

  private async quarantineInvalidFile(): Promise<void> {
    const quarantinePath = `${this.filePath}.invalid-${Date.now()}-${randomUUID()}`
    await rename(this.filePath, quarantinePath).catch((error: unknown) => {
      if (!isNodeError(error, 'ENOENT')) {
        throw error
      }
    })
  }
}

export function emptyRuntimeState(): ProjectRuntimeState {
  return {
    schemaVersion: 1,
    runtimes: [],
    idempotency: []
  }
}

export function parseProjectRuntimeState(
  value: unknown
): ProjectRuntimeState | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'runtimes', 'idempotency']) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.runtimes) ||
    value.runtimes.length > 512 ||
    !Array.isArray(value.idempotency) ||
    value.idempotency.length > 10_000
  ) {
    return null
  }

  const runtimes: ProjectRuntimeEnvelope[] = []
  const runtimeIds = new Set<string>()
  const activeProjects = new Set<string>()
  for (const candidate of value.runtimes) {
    const envelope = parseRuntimeEnvelope(candidate)
    if (!envelope || runtimeIds.has(envelope.runtime.runtimeId)) {
      return null
    }
    runtimeIds.add(envelope.runtime.runtimeId)
    if (!TERMINAL_STATUSES.has(envelope.runtime.status)) {
      if (activeProjects.has(envelope.runtime.projectId)) {
        return null
      }
      activeProjects.add(envelope.runtime.projectId)
    }
    runtimes.push(envelope)
  }

  const idempotency: ProjectIdempotencyRecord[] = []
  const idempotencyKeys = new Set<string>()
  for (const candidate of value.idempotency) {
    const record = parseIdempotencyRecord(candidate)
    const composite = record ? `${record.projectId}\0${record.key}` : ''
    if (!record || idempotencyKeys.has(composite)) {
      return null
    }
    idempotencyKeys.add(composite)
    idempotency.push(record)
  }
  return { schemaVersion: 1, runtimes, idempotency }
}

function parseRuntimeEnvelope(value: unknown): ProjectRuntimeEnvelope | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['runtime', 'projectSnapshot'])
  ) {
    return null
  }
  const runtime = parseRuntimeRecord(value.runtime)
  const projectSnapshot = parseProjectDefinition(value.projectSnapshot)
  if (
    !runtime ||
    !projectSnapshot ||
    runtime.projectId !== projectSnapshot.id ||
    runtime.projectRevision !== projectSnapshot.revision ||
    !projectSnapshot.workflow.nodes.some(
      (node) => node.id === runtime.currentNodeId
    ) ||
    (runtime.checkpointNodeId !== null &&
      !projectSnapshot.workflow.nodes.some(
        (node) => node.id === runtime.checkpointNodeId
      ))
  ) {
    return null
  }
  return { runtime, projectSnapshot }
}

function parseRuntimeRecord(value: unknown): ProjectRuntimeRecord | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'runtimeId',
      'projectId',
      'projectRevision',
      'trigger',
      'status',
      'currentNodeId',
      'nodeAttempt',
      'checkpointNodeId',
      'checkpointData',
      'lastHeartbeatAt',
      'nextWakeAt',
      'lastError',
      'lastFailureCategory',
      'counters',
      'startedAt',
      'updatedAt',
      'completedAt'
    ]) ||
    typeof value.runtimeId !== 'string' ||
    !/^runtime-[a-zA-Z0-9_-]{8,200}$/.test(value.runtimeId) ||
    typeof value.projectId !== 'string' ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(value.projectId) ||
    !isIntegerBetween(value.projectRevision, 1, Number.MAX_SAFE_INTEGER) ||
    typeof value.trigger !== 'string' ||
    !['manual', 'autostart', 'resident', 'schedule', 'resume'].includes(
      value.trigger
    ) ||
    typeof value.status !== 'string' ||
    !Object.hasOwn(TRANSITIONS, value.status) ||
    typeof value.currentNodeId !== 'string' ||
    !/^[a-z][a-z0-9-]{0,79}$/.test(value.currentNodeId) ||
    !isIntegerBetween(value.nodeAttempt, 0, 20) ||
    (value.checkpointNodeId !== null &&
      (typeof value.checkpointNodeId !== 'string' ||
        !/^[a-z][a-z0-9-]{0,79}$/.test(value.checkpointNodeId))) ||
    !isJsonRecord(value.checkpointData) ||
    !isIsoDate(value.lastHeartbeatAt) ||
    (value.nextWakeAt !== null && !isIsoDate(value.nextWakeAt)) ||
    (value.lastError !== null &&
      (typeof value.lastError !== 'string' ||
        value.lastError.length > 4_000)) ||
    (value.lastFailureCategory !== null &&
      !isFailureCategory(value.lastFailureCategory)) ||
    !isCounters(value.counters) ||
    !isIsoDate(value.startedAt) ||
    !isIsoDate(value.updatedAt) ||
    (value.completedAt !== null && !isIsoDate(value.completedAt))
  ) {
    return null
  }
  const status = value.status as ProjectRuntimeStatus
  if (TERMINAL_STATUSES.has(status) !== (value.completedAt !== null)) {
    return null
  }
  return structuredClone(value) as unknown as ProjectRuntimeRecord
}

function parseIdempotencyRecord(
  value: unknown
): ProjectIdempotencyRecord | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'key',
      'projectId',
      'runtimeId',
      'workflowNodeId',
      'result',
      'completedAt'
    ]) ||
    typeof value.key !== 'string' ||
    value.key.length === 0 ||
    value.key.length > 500 ||
    typeof value.projectId !== 'string' ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(value.projectId) ||
    typeof value.runtimeId !== 'string' ||
    !/^runtime-[a-zA-Z0-9_-]{8,200}$/.test(value.runtimeId) ||
    typeof value.workflowNodeId !== 'string' ||
    !/^[a-z][a-z0-9-]{0,79}$/.test(value.workflowNodeId) ||
    !isJsonValue(value.result) ||
    !isIsoDate(value.completedAt)
  ) {
    return null
  }
  return structuredClone(value) as unknown as ProjectIdempotencyRecord
}

function applyTransitionPatch(
  runtime: ProjectRuntimeRecord,
  patch: RuntimeTransitionPatch
): ProjectRuntimeRecord {
  if (
    patch.currentNodeId !== undefined &&
    !/^[a-z][a-z0-9-]{0,79}$/.test(patch.currentNodeId)
  ) {
    throw new Error('Workflow 节点 ID 格式无效')
  }
  if (
    patch.nodeAttempt !== undefined &&
    !isIntegerBetween(patch.nodeAttempt, 0, 20)
  ) {
    throw new Error('Workflow 节点尝试次数无效')
  }
  if (
    patch.nextWakeAt !== undefined &&
    patch.nextWakeAt !== null &&
    !isIsoDate(patch.nextWakeAt)
  ) {
    throw new Error('Runtime 唤醒时间无效')
  }
  if (
    patch.lastError !== undefined &&
    patch.lastError !== null &&
    patch.lastError.length > 4_000
  ) {
    throw new Error('Runtime 错误信息过长')
  }
  if (
    patch.lastFailureCategory !== undefined &&
    patch.lastFailureCategory !== null &&
    !isFailureCategory(patch.lastFailureCategory)
  ) {
    throw new Error('Runtime 失败分类无效')
  }
  const counters = { ...runtime.counters }
  for (const [key, delta] of Object.entries(patch.counters ?? {})) {
    if (
      !Object.hasOwn(counters, key) ||
      typeof delta !== 'number' ||
      !Number.isSafeInteger(delta) ||
      delta < 0
    ) {
      throw new Error('Runtime 计数增量无效')
    }
    counters[key as keyof ProjectRuntimeCounters] += delta
  }
  return {
    ...runtime,
    ...(patch.currentNodeId === undefined
      ? {}
      : { currentNodeId: patch.currentNodeId }),
    ...(patch.nodeAttempt === undefined
      ? {}
      : { nodeAttempt: patch.nodeAttempt }),
    ...(patch.checkpointNodeId === undefined
      ? {}
      : { checkpointNodeId: patch.checkpointNodeId }),
    ...(patch.checkpointData === undefined
      ? {}
      : { checkpointData: structuredClone(patch.checkpointData) }),
    ...(patch.nextWakeAt === undefined
      ? {}
      : { nextWakeAt: patch.nextWakeAt }),
    ...(patch.lastError === undefined
      ? {}
      : { lastError: patch.lastError }),
    ...(patch.lastFailureCategory === undefined
      ? {}
      : { lastFailureCategory: patch.lastFailureCategory }),
    counters
  }
}

function validateIdempotencyRecordInput(
  value: Omit<ProjectIdempotencyRecord, 'completedAt'>
): void {
  if (
    !parseIdempotencyRecord({
      ...value,
      completedAt: new Date(0).toISOString()
    })
  ) {
    throw new Error('幂等记录格式无效')
  }
}

function pruneRuntimes(
  runtimes: ProjectRuntimeEnvelope[]
): ProjectRuntimeEnvelope[] {
  if (runtimes.length <= 512) {
    return runtimes
  }
  const active = runtimes.filter(
    ({ runtime }) => !TERMINAL_STATUSES.has(runtime.status)
  )
  const terminal = runtimes
    .filter(({ runtime }) => TERMINAL_STATUSES.has(runtime.status))
    .sort((left, right) =>
      left.runtime.updatedAt.localeCompare(right.runtime.updatedAt)
    )
  return [...terminal.slice(-(512 - active.length)), ...active]
}

function createRuntimeId(createId: () => string): string {
  const value = createId()
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z0-9_-]{8,200}$/.test(value)
  ) {
    throw new Error('无法创建 Project Runtime ID')
  }
  return `runtime-${value}`
}

function isCounters(value: unknown): value is ProjectRuntimeCounters {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, Object.keys(EMPTY_COUNTERS))
  ) {
    return false
  }
  return Object.values(value).every(
    (counter) =>
      typeof counter === 'number' &&
      Number.isSafeInteger(counter) &&
      counter >= 0
  )
}

function isFailureCategory(value: unknown): value is WorkflowFailureCategory {
  return (
    typeof value === 'string' &&
    [
      'network',
      'timeout',
      'authentication',
      'page-changed',
      'renderer',
      'disk',
      'cancelled',
      'unknown'
    ].includes(value)
  )
}

function isJsonRecord(
  value: unknown
): value is Record<string, JsonValue> {
  return isRecord(value) && isJsonValue(value)
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 20) {
    return false
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
  }
  if (Array.isArray(value)) {
    return (
      value.length <= 1_000 &&
      value.every((entry) => isJsonValue(entry, depth + 1))
    )
  }
  return (
    isRecord(value) &&
    Object.keys(value).length <= 1_000 &&
    Object.values(value).every((entry) => isJsonValue(entry, depth + 1))
  )
}

function isIntegerBetween(
  value: unknown,
  minimum: number,
  maximum: number
): boolean {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  )
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[]
): boolean {
  const keys = Object.keys(value)
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
