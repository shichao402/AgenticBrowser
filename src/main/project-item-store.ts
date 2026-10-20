import { randomUUID } from 'node:crypto'
import { rename } from 'node:fs/promises'

import type { JsonValue } from '../shared/contracts'
import { isNodeError, readJsonFile, writeJsonAtomic } from './atomic-file'

export type ProjectItemClassification = 'matched' | 'skipped'

export interface ProjectItemObservation {
  runtimeId: string
  sourceUrl: string
  businessItemId: string
  text: string
  classification: ProjectItemClassification
  attachmentCount: number
  publishedAt: string | null
  metadata: Record<string, JsonValue>
}

export interface ProjectItemRecord extends ProjectItemObservation {
  projectId: string
  firstSeenAt: string
  lastSeenAt: string
  lastRuntimeId: string
  seenCount: number
}

export interface ProjectItemState {
  schemaVersion: 1
  records: ProjectItemRecord[]
}

export interface ProjectItemObservationResult {
  kind: 'created' | 'updated'
  firstSeenInRuntime: boolean
  record: ProjectItemRecord
}

export interface ProjectItemStoreOptions {
  now?: () => number
  maximumRecords?: number
}

export class ProjectItemStore {
  private queue = Promise.resolve()
  private readonly now: () => number
  private readonly maximumRecords: number

  constructor(
    readonly filePath: string,
    options: ProjectItemStoreOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.maximumRecords = options.maximumRecords ?? 50_000
    if (
      !Number.isSafeInteger(this.maximumRecords) ||
      this.maximumRecords < 1 ||
      this.maximumRecords > 100_000
    ) {
      throw new Error('Project item 记录上限无效')
    }
  }

  async read(): Promise<ProjectItemState> {
    let value: unknown | null
    try {
      value = await readJsonFile(this.filePath)
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error
      }
      await this.quarantineInvalidFile()
      return emptyProjectItemState()
    }
    if (value === null) {
      return emptyProjectItemState()
    }
    const state = parseProjectItemState(value)
    if (state) {
      return state
    }
    await this.quarantineInvalidFile()
    return emptyProjectItemState()
  }

  observe(
    projectId: string,
    value: unknown,
    sourcePage: string,
    runtimeId: string
  ): Promise<ProjectItemObservationResult> {
    const observation = parseProjectItemObservation(
      value,
      sourcePage,
      runtimeId
    )
    if (!PROJECT_ID.test(projectId) || !observation) {
      throw new Error('Project item 观测格式无效')
    }
    return this.enqueue(async () => {
      const state = await this.read()
      const index = state.records.findIndex(
        (record) =>
          record.projectId === projectId &&
          record.businessItemId === observation.businessItemId
      )
      const observedAt = new Date(this.now()).toISOString()
      if (index < 0) {
        const record: ProjectItemRecord = {
          ...observation,
          projectId,
          firstSeenAt: observedAt,
          lastSeenAt: observedAt,
          lastRuntimeId: runtimeId,
          seenCount: 1
        }
        await writeJsonAtomic(this.filePath, {
          schemaVersion: 1,
          records: pruneRecords([...state.records, record], this.maximumRecords)
        } satisfies ProjectItemState)
        return {
          kind: 'created',
          firstSeenInRuntime: true,
          record: structuredClone(record)
        }
      }

      const existing = state.records[index]!
      const firstSeenInRuntime = existing.lastRuntimeId !== runtimeId
      const record: ProjectItemRecord = {
        ...existing,
        ...observation,
        projectId,
        firstSeenAt: existing.firstSeenAt,
        lastSeenAt: observedAt,
        lastRuntimeId: runtimeId,
        seenCount: existing.seenCount + (firstSeenInRuntime ? 1 : 0)
      }
      const records = [...state.records]
      records[index] = record
      await writeJsonAtomic(this.filePath, {
        schemaVersion: 1,
        records: pruneRecords(records, this.maximumRecords)
      } satisfies ProjectItemState)
      return {
        kind: 'updated',
        firstSeenInRuntime,
        record: structuredClone(record)
      }
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation)
    this.queue = pending.then(
      () => undefined,
      () => undefined
    )
    return pending
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

export function emptyProjectItemState(): ProjectItemState {
  return { schemaVersion: 1, records: [] }
}

export function parseProjectItemState(value: unknown): ProjectItemState | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'records']) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.records) ||
    value.records.length > 100_000
  ) {
    return null
  }
  const records: ProjectItemRecord[] = []
  const keys = new Set<string>()
  for (const candidate of value.records) {
    const record = parseProjectItemRecord(candidate)
    const key = record
      ? `${record.projectId}\u0000${record.businessItemId}`
      : ''
    if (!record || keys.has(key)) {
      return null
    }
    keys.add(key)
    records.push(record)
  }
  return { schemaVersion: 1, records }
}

export function parseProjectItemObservation(
  value: unknown,
  sourcePage: string,
  runtimeId: string
): ProjectItemObservation | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'businessItemId',
      'sourceUrl',
      'text',
      'classification',
      'attachmentCount',
      'publishedAt',
      'metadata'
    ]) ||
    !hasRequiredKeys(value, [
      'businessItemId',
      'text',
      'classification',
      'attachmentCount'
    ]) ||
    !RUNTIME_ID.test(runtimeId) ||
    !isHttpUrl(sourcePage)
  ) {
    return null
  }
  const sourceUrl = value.sourceUrl === undefined ? sourcePage : value.sourceUrl
  const publishedAt = value.publishedAt === undefined ? null : value.publishedAt
  const metadata = value.metadata === undefined ? {} : value.metadata
  if (
    typeof value.businessItemId !== 'string' ||
    value.businessItemId.trim().length === 0 ||
    value.businessItemId.length > 500 ||
    typeof sourceUrl !== 'string' ||
    !isHttpUrl(sourceUrl) ||
    typeof value.text !== 'string' ||
    value.text.length > 50_000 ||
    (value.classification !== 'matched' &&
      value.classification !== 'skipped') ||
    !isIntegerBetween(value.attachmentCount, 0, 1_000) ||
    (publishedAt !== null &&
      (typeof publishedAt !== 'string' ||
        Number.isNaN(Date.parse(publishedAt)))) ||
    !isRecord(metadata) ||
    !isJsonValue(metadata) ||
    Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 64 * 1024
  ) {
    return null
  }
  return {
    runtimeId,
    sourceUrl: new URL(sourceUrl).toString(),
    businessItemId: value.businessItemId.trim(),
    text: value.text,
    classification: value.classification,
    attachmentCount: value.attachmentCount as number,
    publishedAt: publishedAt as string | null,
    metadata: structuredClone(metadata) as Record<string, JsonValue>
  }
}

function parseProjectItemRecord(value: unknown): ProjectItemRecord | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'runtimeId',
      'sourceUrl',
      'businessItemId',
      'text',
      'classification',
      'attachmentCount',
      'publishedAt',
      'metadata',
      'projectId',
      'firstSeenAt',
      'lastSeenAt',
      'lastRuntimeId',
      'seenCount'
    ]) ||
    typeof value.projectId !== 'string' ||
    !PROJECT_ID.test(value.projectId) ||
    typeof value.firstSeenAt !== 'string' ||
    Number.isNaN(Date.parse(value.firstSeenAt)) ||
    typeof value.lastSeenAt !== 'string' ||
    Number.isNaN(Date.parse(value.lastSeenAt)) ||
    typeof value.lastRuntimeId !== 'string' ||
    !RUNTIME_ID.test(value.lastRuntimeId) ||
    !isIntegerBetween(value.seenCount, 1, Number.MAX_SAFE_INTEGER)
  ) {
    return null
  }
  const observation = parseProjectItemObservation(
    {
      businessItemId: value.businessItemId,
      sourceUrl: value.sourceUrl,
      text: value.text,
      classification: value.classification,
      attachmentCount: value.attachmentCount,
      publishedAt: value.publishedAt,
      metadata: value.metadata
    },
    value.sourceUrl as string,
    value.runtimeId as string
  )
  if (!observation || observation.runtimeId !== value.lastRuntimeId) {
    return null
  }
  return {
    ...observation,
    projectId: value.projectId,
    firstSeenAt: value.firstSeenAt,
    lastSeenAt: value.lastSeenAt,
    lastRuntimeId: value.lastRuntimeId,
    seenCount: value.seenCount as number
  }
}

function pruneRecords(
  records: ProjectItemRecord[],
  maximum: number
): ProjectItemRecord[] {
  if (records.length <= maximum) {
    return records
  }
  return [...records]
    .sort((left, right) => left.lastSeenAt.localeCompare(right.lastSeenAt))
    .slice(-maximum)
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username.length === 0 &&
      url.password.length === 0
    )
  } catch {
    return false
  }
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 20) {
    return false
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
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

function hasOnlyKeys(
  value: Record<string, unknown>,
  expected: string[]
): boolean {
  return Object.keys(value).every((key) => expected.includes(key))
}

function hasRequiredKeys(
  value: Record<string, unknown>,
  required: string[]
): boolean {
  return required.every((key) => Object.hasOwn(value, key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const PROJECT_ID = /^[a-z][a-z0-9-]{0,63}$/
const RUNTIME_ID = /^runtime-[a-zA-Z0-9_-]{8,200}$/
