import { randomUUID } from 'node:crypto'
import { rename } from 'node:fs/promises'

import type {
  JsonValue,
  StrategyDefinition,
  StrategyFrameScope,
  StrategyManifest,
  StrategyPermission,
  StrategyRunAt
} from '../shared/contracts'
import {
  isNodeError,
  readJsonFile,
  writeJsonAtomic
} from './atomic-file'
import { isValidStrategyMatchPattern } from './strategy-match'

export interface StrategyState {
  schemaVersion: 1
  strategies: StrategyDefinition[]
}

export interface StrategyDraft {
  manifest: StrategyManifest
  source: string
  enabled: boolean
}

const RUN_AT_VALUES = new Set<StrategyRunAt>([
  'document-start',
  'document-end',
  'document-idle'
])
const FRAME_VALUES = new Set<StrategyFrameScope>(['top', 'all'])
const PERMISSION_VALUES = new Set<StrategyPermission>([
  'dom.read',
  'dom.write',
  'dom.click',
  'config.read',
  'log',
  'project.emit-event',
  'network.request',
  'main-world'
])
const MANIFEST_KEYS = [
  'id',
  'name',
  'version',
  'matches',
  'excludes',
  'runAt',
  'frames',
  'permissions',
  'networkMatches',
  'config',
  'timeouts'
]

export class StrategyStore {
  private queue = Promise.resolve()

  constructor(readonly filePath: string) {}

  async read(): Promise<StrategyState> {
    let value: unknown | null
    try {
      value = await readJsonFile(this.filePath)
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error
      }
      await this.quarantineInvalidFile()
      return emptyStrategyState()
    }

    if (value === null) {
      return emptyStrategyState()
    }
    const state = parseStrategyState(value)
    if (state) {
      return state
    }
    await this.quarantineInvalidFile()
    return emptyStrategyState()
  }

  async save(value: unknown): Promise<StrategyState> {
    const draft = parseStrategyDraft(value)
    if (!draft) {
      throw new Error('Strategy 定义格式无效')
    }
    return this.update((state) => {
      const definition: StrategyDefinition = {
        ...draft,
        updatedAt: new Date().toISOString()
      }
      return {
        schemaVersion: 1,
        strategies: [
          ...state.strategies.filter(
            (item) => item.manifest.id !== definition.manifest.id
          ),
          definition
        ].sort(compareStrategyDefinitions)
      }
    })
  }

  async setEnabled(id: string, enabled: boolean): Promise<StrategyState> {
    requireStrategyId(id)
    return this.update((state) => {
      let found = false
      const strategies = state.strategies.map((definition) => {
        if (definition.manifest.id !== id) {
          return definition
        }
        found = true
        return {
          ...definition,
          enabled,
          updatedAt: new Date().toISOString()
        }
      })
      if (!found) {
        throw new Error(`Strategy 不存在：${id}`)
      }
      return { schemaVersion: 1, strategies }
    })
  }

  async delete(id: string): Promise<StrategyState> {
    requireStrategyId(id)
    return this.update((state) => {
      if (!state.strategies.some((item) => item.manifest.id === id)) {
        throw new Error(`Strategy 不存在：${id}`)
      }
      return {
        schemaVersion: 1,
        strategies: state.strategies.filter(
          (item) => item.manifest.id !== id
        )
      }
    })
  }

  private async update(
    transform: (state: StrategyState) => StrategyState
  ): Promise<StrategyState> {
    let result: StrategyState | null = null
    const operation = this.queue.then(async () => {
      result = transform(await this.read())
      await writeJsonAtomic(this.filePath, result)
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

export function emptyStrategyState(): StrategyState {
  return {
    schemaVersion: 1,
    strategies: []
  }
}

export function parseStrategyState(value: unknown): StrategyState | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'strategies']) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.strategies) ||
    value.strategies.length > 256
  ) {
    return null
  }

  const strategies: StrategyDefinition[] = []
  const ids = new Set<string>()
  for (const candidate of value.strategies) {
    const definition = parseStrategyDefinition(candidate)
    if (!definition || ids.has(definition.manifest.id)) {
      return null
    }
    ids.add(definition.manifest.id)
    strategies.push(definition)
  }
  strategies.sort(compareStrategyDefinitions)
  return { schemaVersion: 1, strategies }
}

export function parseStrategyManifest(
  value: unknown
): StrategyManifest | null {
  if (!isRecord(value) || !hasExactKeys(value, MANIFEST_KEYS)) {
    return null
  }
  if (
    typeof value.id !== 'string' ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(value.id) ||
    typeof value.name !== 'string' ||
    value.name.trim().length === 0 ||
    value.name.trim().length > 80 ||
    typeof value.version !== 'string' ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(
      value.version
    ) ||
    !isPatternArray(value.matches, 1, 64) ||
    !isPatternArray(value.excludes, 0, 64) ||
    typeof value.runAt !== 'string' ||
    !RUN_AT_VALUES.has(value.runAt as StrategyRunAt) ||
    typeof value.frames !== 'string' ||
    !FRAME_VALUES.has(value.frames as StrategyFrameScope) ||
    !isPermissionArray(value.permissions) ||
    !isPatternArray(value.networkMatches, 0, 64) ||
    !isRecord(value.config) ||
    !isJsonValue(value.config) ||
    !isRecord(value.timeouts) ||
    !hasExactKeys(value.timeouts, ['startupMs', 'heartbeatMs']) ||
    !isIntegerBetween(value.timeouts.startupMs, 100, 60_000) ||
    !isIntegerBetween(value.timeouts.heartbeatMs, 500, 120_000)
  ) {
    return null
  }

  return {
    id: value.id,
    name: value.name.trim(),
    version: value.version,
    matches: [...value.matches] as string[],
    excludes: [...value.excludes] as string[],
    runAt: value.runAt as StrategyRunAt,
    frames: value.frames as StrategyFrameScope,
    permissions: [...value.permissions] as StrategyPermission[],
    networkMatches: [...value.networkMatches] as string[],
    config: cloneJsonRecord(value.config),
    timeouts: {
      startupMs: value.timeouts.startupMs as number,
      heartbeatMs: value.timeouts.heartbeatMs as number
    }
  }
}

function parseStrategyDraft(value: unknown): StrategyDraft | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['manifest', 'source', 'enabled'])
  ) {
    return null
  }
  const manifest = parseStrategyManifest(value.manifest)
  if (
    !manifest ||
    typeof value.source !== 'string' ||
    value.source.length > 512 * 1024 ||
    typeof value.enabled !== 'boolean'
  ) {
    return null
  }
  return {
    manifest,
    source: value.source,
    enabled: value.enabled
  }
}

function parseStrategyDefinition(
  value: unknown
): StrategyDefinition | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'manifest',
      'source',
      'enabled',
      'updatedAt'
    ])
  ) {
    return null
  }
  const draft = parseStrategyDraft({
    manifest: value.manifest,
    source: value.source,
    enabled: value.enabled
  })
  if (
    !draft ||
    typeof value.updatedAt !== 'string' ||
    Number.isNaN(Date.parse(value.updatedAt))
  ) {
    return null
  }
  return {
    ...draft,
    updatedAt: value.updatedAt
  }
}

function isPatternArray(
  value: unknown,
  minimum: number,
  maximum: number
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= minimum &&
    value.length <= maximum &&
    value.every(
      (item) =>
        typeof item === 'string' && isValidStrategyMatchPattern(item)
    ) &&
    new Set(value).size === value.length
  )
}

function isPermissionArray(value: unknown): value is StrategyPermission[] {
  return (
    Array.isArray(value) &&
    value.length <= PERMISSION_VALUES.size &&
    value.every(
      (item) =>
        typeof item === 'string' &&
        PERMISSION_VALUES.has(item as StrategyPermission)
    ) &&
    new Set(value).size === value.length
  )
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
      value.every((item) => isJsonValue(item, depth + 1))
    )
  }
  if (!isRecord(value) || Object.keys(value).length > 1_000) {
    return false
  }
  return Object.values(value).every((item) =>
    isJsonValue(item, depth + 1)
  )
}

function cloneJsonRecord(
  value: Record<string, unknown>
): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>
}

function compareStrategyDefinitions(
  left: StrategyDefinition,
  right: StrategyDefinition
): number {
  return left.manifest.id < right.manifest.id
    ? -1
    : left.manifest.id > right.manifest.id
      ? 1
      : 0
}

function requireStrategyId(id: string): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) {
    throw new Error('Strategy ID 格式无效')
  }
}

function isIntegerBetween(
  value: unknown,
  minimum: number,
  maximum: number
): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  )
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: string[]
): boolean {
  const actual = Object.keys(value)
  return (
    actual.length === keys.length &&
    actual.every((key) => keys.includes(key))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
