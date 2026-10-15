import { randomUUID } from 'node:crypto'

import type {
  JsonValue,
  StrategyBootstrapEntry,
  StrategyBootstrapResponse,
  StrategyDefinition,
  StrategyHostCall,
  StrategyLogLevel,
  StrategyNetworkRequest,
  StrategyNetworkResponse,
  StrategyPermission,
  StrategyRuntimeEntrySnapshot,
  StrategyRuntimeSignal,
  StrategyRuntimeSnapshot,
  StrategyRuntimeStatus
} from '../shared/contracts'
import {
  resolveMatchingStrategies,
  urlMatchesStrategyPattern
} from './strategy-match'

const FIRST_STRATEGY_WORLD_ID = 1_001
const INSTALL_TIMEOUT_MS = 5_000
const MAX_HOST_PAYLOAD_BYTES = 128 * 1024
const MAX_LOG_MESSAGE_LENGTH = 2_000

export interface StrategyFrameContext {
  frameTreeNodeId: number
  url: string
  isMainFrame: boolean
}

export type StrategyRuntimeEventType =
  | 'strategy-started'
  | 'strategy-ready'
  | 'strategy-log'
  | 'strategy-event'
  | 'strategy-failed'
  | 'strategy-heartbeat-missed'

export interface StrategyRuntimeEvent {
  type: StrategyRuntimeEventType
  strategyId: string
  detail: string
}

export interface StrategyRuntimeOptions {
  definitions: StrategyDefinition[]
  allowedStrategyIds: ReadonlySet<string>
  quarantinedStrategyIds?: ReadonlySet<string>
  onEvent?: (event: StrategyRuntimeEvent) => void
  onFault?: (strategyId: string, reason: string) => void
  requestNetwork?: (
    definition: StrategyDefinition,
    request: StrategyNetworkRequest
  ) => Promise<StrategyNetworkResponse>
  now?: () => number
  createToken?: () => string
  monitorIntervalMs?: number
}

interface StrategyLease {
  token: string
  definition: StrategyDefinition
  frame: StrategyFrameContext
  status: StrategyRuntimeStatus
  issuedAt: number
  startedAt: number | null
  lastHeartbeatAt: number | null
  failure: string | null
  faultReported: boolean
}

export class StrategyRuntime {
  private readonly definitions: StrategyDefinition[]
  private readonly allowedStrategyIds: ReadonlySet<string>
  private readonly quarantinedStrategyIds: ReadonlySet<string>
  private readonly leases = new Map<string, StrategyLease>()
  private readonly worldIds = new Map<string, number>()
  private readonly now: () => number
  private readonly createToken: () => string
  private monitor: NodeJS.Timeout | null = null

  constructor(private readonly options: StrategyRuntimeOptions) {
    this.definitions = [...options.definitions].sort(compareDefinitions)
    this.allowedStrategyIds = new Set(options.allowedStrategyIds)
    this.quarantinedStrategyIds = new Set(
      options.quarantinedStrategyIds ?? []
    )
    this.now = options.now ?? Date.now
    this.createToken = options.createToken ?? randomUUID
    this.definitions.forEach((definition, index) => {
      this.worldIds.set(
        definition.manifest.id,
        FIRST_STRATEGY_WORLD_ID + index
      )
    })
  }

  start(): void {
    if (this.monitor) {
      return
    }
    this.monitor = setInterval(
      () => this.checkHealth(),
      this.options.monitorIntervalMs ?? 250
    )
    this.monitor.unref()
  }

  bootstrap(frame: StrategyFrameContext): StrategyBootstrapResponse {
    this.revokeForDocument(frame)
    const allowed = new Set(
      [...this.allowedStrategyIds].filter(
        (id) => !this.quarantinedStrategyIds.has(id)
      )
    )
    const matches = resolveMatchingStrategies(this.definitions, {
      url: frame.url,
      isMainFrame: frame.isMainFrame,
      allowedStrategyIds: allowed
    })
    const entries = matches.map((definition) =>
      this.issueLease(definition, frame)
    )
    return { entries }
  }

  signal(frame: StrategyFrameContext, value: unknown): boolean {
    const signal = parseSignal(value)
    if (!signal) {
      return false
    }
    const lease = this.requireLease(signal.token, frame)
    if (!lease) {
      return false
    }

    const now = this.now()
    switch (signal.type) {
      case 'installed':
        if (lease.status === 'issued') {
          lease.status = 'scheduled'
        }
        return true
      case 'started':
        if (lease.status !== 'issued' && lease.status !== 'scheduled') {
          return lease.status === 'starting' || lease.status === 'running'
        }
        lease.status = 'starting'
        lease.startedAt = now
        lease.lastHeartbeatAt = now
        this.emit(
          'strategy-started',
          lease,
          `${lease.definition.manifest.id}@${lease.definition.manifest.version}`
        )
        return true
      case 'heartbeat':
        if (lease.status !== 'starting' && lease.status !== 'running') {
          return false
        }
        lease.lastHeartbeatAt = now
        return true
      case 'ready':
        if (lease.status !== 'starting' && lease.status !== 'running') {
          return false
        }
        lease.status = 'running'
        lease.lastHeartbeatAt = now
        this.emit(
          'strategy-ready',
          lease,
          `${lease.definition.manifest.id}@${lease.definition.manifest.version}`
        )
        return true
      case 'failed':
        this.failLease(
          lease,
          signal.detail ?? 'Strategy 执行失败',
          'strategy-failed'
        )
        return true
    }
  }

  async invoke(
    frame: StrategyFrameContext,
    value: unknown
  ): Promise<JsonValue> {
    const call = parseHostCall(value)
    if (!call) {
      throw new Error('Strategy 宿主调用格式无效')
    }
    const lease = this.requireLease(call.token, frame)
    if (
      !lease ||
      (lease.status !== 'starting' && lease.status !== 'running')
    ) {
      throw new Error('Strategy 执行令牌已失效')
    }

    switch (call.method) {
      case 'log':
        this.requirePermission(lease, 'log')
        return this.handleLog(lease, call.payload)
      case 'emit-event':
        this.requirePermission(lease, 'project.emit-event')
        return this.handleDomainEvent(lease, call.payload)
      case 'network-request':
        this.requirePermission(lease, 'network.request')
        return this.handleNetworkRequest(lease, call.payload)
      case 'main-world-eval':
        this.requirePermission(lease, 'main-world')
        return this.handleMainWorldAudit(lease, call.payload)
    }
  }

  checkHealth(): void {
    const now = this.now()
    for (const lease of this.leases.values()) {
      if (
        lease.status === 'issued' &&
        now - lease.issuedAt > INSTALL_TIMEOUT_MS
      ) {
        this.failLease(
          lease,
          'Strategy bootstrap 安装超时',
          'strategy-failed'
        )
        continue
      }

      if (
        lease.status === 'starting' &&
        lease.startedAt !== null &&
        now - lease.startedAt > lease.definition.manifest.timeouts.startupMs
      ) {
        this.failLease(
          lease,
          `启动超过 ${lease.definition.manifest.timeouts.startupMs} ms`,
          'strategy-heartbeat-missed'
        )
        continue
      }

      if (
        lease.status === 'running' &&
        lease.lastHeartbeatAt !== null &&
        now - lease.lastHeartbeatAt >
          lease.definition.manifest.timeouts.heartbeatMs * 2
      ) {
        this.failLease(
          lease,
          `心跳超过 ${lease.definition.manifest.timeouts.heartbeatMs * 2} ms`,
          'strategy-heartbeat-missed'
        )
      }
    }
  }

  getSnapshot(): StrategyRuntimeSnapshot {
    const entries = [...this.leases.values()]
      .map<StrategyRuntimeEntrySnapshot>((lease) => ({
        strategyId: lease.definition.manifest.id,
        name: lease.definition.manifest.name,
        version: lease.definition.manifest.version,
        url: lease.frame.url,
        isMainFrame: lease.frame.isMainFrame,
        status: lease.status,
        startedAt:
          lease.startedAt === null
            ? null
            : new Date(lease.startedAt).toISOString(),
        lastHeartbeatAt:
          lease.lastHeartbeatAt === null
            ? null
            : new Date(lease.lastHeartbeatAt).toISOString(),
        failure: lease.failure
      }))
      .sort((left, right) =>
        left.strategyId === right.strategyId
          ? left.url.localeCompare(right.url)
          : left.strategyId.localeCompare(right.strategyId)
      )

    return {
      activeCount: entries.filter(
        (entry) =>
          entry.status === 'starting' || entry.status === 'running'
      ).length,
      quarantinedStrategyIds: [...this.quarantinedStrategyIds].sort(),
      entries
    }
  }

  dispose(): void {
    if (this.monitor) {
      clearInterval(this.monitor)
      this.monitor = null
    }
    this.leases.clear()
  }

  private issueLease(
    definition: StrategyDefinition,
    frame: StrategyFrameContext
  ): StrategyBootstrapEntry {
    const token = this.createUniqueToken()
    const lease: StrategyLease = {
      token,
      definition,
      frame: { ...frame },
      status: 'issued',
      issuedAt: this.now(),
      startedAt: null,
      lastHeartbeatAt: null,
      failure: null,
      faultReported: false
    }
    this.leases.set(token, lease)

    return {
      token,
      worldId: this.worldIds.get(definition.manifest.id)!,
      strategyId: definition.manifest.id,
      version: definition.manifest.version,
      runAt: definition.manifest.runAt,
      permissions: [...definition.manifest.permissions],
      source: definition.source,
      config: definition.manifest.permissions.includes('config.read')
        ? cloneJsonRecord(definition.manifest.config)
        : {},
      startupMs: definition.manifest.timeouts.startupMs,
      heartbeatMs: definition.manifest.timeouts.heartbeatMs
    }
  }

  private createUniqueToken(): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const token = this.createToken()
      if (
        typeof token === 'string' &&
        token.length >= 16 &&
        token.length <= 200 &&
        !this.leases.has(token)
      ) {
        return token
      }
    }
    throw new Error('无法创建唯一 Strategy 执行令牌')
  }

  private revokeForDocument(frame: StrategyFrameContext): void {
    for (const [token, lease] of this.leases) {
      if (
        frame.isMainFrame ||
        lease.frame.frameTreeNodeId === frame.frameTreeNodeId
      ) {
        this.leases.delete(token)
      }
    }
  }

  private requireLease(
    token: string,
    frame: StrategyFrameContext
  ): StrategyLease | null {
    const lease = this.leases.get(token)
    if (
      !lease ||
      lease.frame.frameTreeNodeId !== frame.frameTreeNodeId ||
      lease.frame.isMainFrame !== frame.isMainFrame
    ) {
      return null
    }
    return lease
  }

  private requirePermission(
    lease: StrategyLease,
    permission: StrategyPermission
  ): void {
    if (!lease.definition.manifest.permissions.includes(permission)) {
      throw new Error(
        `Strategy ${lease.definition.manifest.id} 未声明 ${permission} 权限`
      )
    }
  }

  private handleLog(
    lease: StrategyLease,
    payload: JsonValue
  ): JsonValue {
    if (!isRecord(payload)) {
      throw new Error('Strategy 日志参数无效')
    }
    const level = payload.level
    const message = payload.message
    if (
      typeof level !== 'string' ||
      !isStrategyLogLevel(level) ||
      typeof message !== 'string' ||
      message.length === 0 ||
      message.length > MAX_LOG_MESSAGE_LENGTH
    ) {
      throw new Error('Strategy 日志级别或内容无效')
    }
    const data = payload.data
    this.emit(
      'strategy-log',
      lease,
      `[${level}] ${message}${data === undefined ? '' : ` ${safeJson(data)}`}`
    )
    return null
  }

  private handleDomainEvent(
    lease: StrategyLease,
    payload: JsonValue
  ): JsonValue {
    if (
      !isRecord(payload) ||
      typeof payload.name !== 'string' ||
      !/^[a-z][a-z0-9.-]{0,79}$/.test(payload.name)
    ) {
      throw new Error('Strategy 领域事件名称无效')
    }
    this.emit(
      'strategy-event',
      lease,
      `${payload.name}${
        payload.payload === undefined ? '' : ` ${safeJson(payload.payload)}`
      }`
    )
    return null
  }

  private async handleNetworkRequest(
    lease: StrategyLease,
    payload: JsonValue
  ): Promise<JsonValue> {
    const request = parseNetworkRequest(payload)
    if (!request) {
      throw new Error('Strategy 网络请求格式无效')
    }
    if (
      !lease.definition.manifest.networkMatches.some((pattern) =>
        urlMatchesStrategyPattern(request.url, pattern)
      )
    ) {
      throw new Error(`Strategy 网络请求未命中 allowlist：${request.url}`)
    }
    if (!this.options.requestNetwork) {
      throw new Error('Strategy 网络请求执行器不可用')
    }
    const response = await this.options.requestNetwork(
      lease.definition,
      request
    )
    return response as unknown as JsonValue
  }

  private handleMainWorldAudit(
    lease: StrategyLease,
    payload: JsonValue
  ): JsonValue {
    if (
      !isRecord(payload) ||
      typeof payload.sourceLength !== 'number' ||
      !Number.isInteger(payload.sourceLength) ||
      payload.sourceLength < 1 ||
      payload.sourceLength > 64 * 1024
    ) {
      throw new Error('main-world 执行参数无效')
    }
    this.emit(
      'strategy-event',
      lease,
      `main-world-eval sourceLength=${payload.sourceLength}`
    )
    return null
  }

  private failLease(
    lease: StrategyLease,
    reason: string,
    eventType: Extract<
      StrategyRuntimeEventType,
      'strategy-failed' | 'strategy-heartbeat-missed'
    >
  ): void {
    if (lease.status === 'failed') {
      return
    }
    lease.status = 'failed'
    lease.failure = truncate(reason, MAX_LOG_MESSAGE_LENGTH)
    this.emit(eventType, lease, lease.failure)
    if (!lease.faultReported) {
      lease.faultReported = true
      this.options.onFault?.(lease.definition.manifest.id, lease.failure)
    }
  }

  private emit(
    type: StrategyRuntimeEventType,
    lease: StrategyLease,
    detail: string
  ): void {
    this.options.onEvent?.({
      type,
      strategyId: lease.definition.manifest.id,
      detail: truncate(detail, 4_000)
    })
  }
}

function parseSignal(value: unknown): StrategyRuntimeSignal | null {
  if (
    !isRecord(value) ||
    typeof value.token !== 'string' ||
    value.token.length < 16 ||
    value.token.length > 200 ||
    typeof value.type !== 'string' ||
    !['installed', 'started', 'ready', 'heartbeat', 'failed'].includes(
      value.type
    ) ||
    (value.detail !== undefined &&
      (typeof value.detail !== 'string' || value.detail.length > 4_000))
  ) {
    return null
  }
  return {
    token: value.token,
    type: value.type as StrategyRuntimeSignal['type'],
    ...(typeof value.detail === 'string' ? { detail: value.detail } : {})
  }
}

function parseHostCall(value: unknown): StrategyHostCall | null {
  if (
    !isRecord(value) ||
    typeof value.token !== 'string' ||
    value.token.length < 16 ||
    value.token.length > 200 ||
    typeof value.method !== 'string' ||
    ![
      'log',
      'emit-event',
      'network-request',
      'main-world-eval'
    ].includes(value.method) ||
    !isJsonValue(value.payload) ||
    jsonByteLength(value.payload) > MAX_HOST_PAYLOAD_BYTES
  ) {
    return null
  }
  return {
    token: value.token,
    method: value.method as StrategyHostCall['method'],
    payload: value.payload
  }
}

function parseNetworkRequest(
  value: JsonValue
): StrategyNetworkRequest | null {
  if (!isRecord(value) || typeof value.url !== 'string') {
    return null
  }
  let url: URL
  try {
    url = new URL(value.url)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null
  }

  const method = value.method ?? 'GET'
  if (
    typeof method !== 'string' ||
    !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)
  ) {
    return null
  }
  if (
    value.body !== undefined &&
    (typeof value.body !== 'string' ||
      Buffer.byteLength(value.body, 'utf8') > 256 * 1024)
  ) {
    return null
  }
  if (value.headers !== undefined && !isStringRecord(value.headers)) {
    return null
  }

  return {
    url: url.toString(),
    method: method as NonNullable<StrategyNetworkRequest['method']>,
    ...(value.headers === undefined
      ? {}
      : { headers: { ...value.headers } as Record<string, string> }),
    ...(typeof value.body === 'string' ? { body: value.body } : {})
  }
}

function isStrategyLogLevel(value: string): value is StrategyLogLevel {
  return ['debug', 'info', 'warn', 'error'].includes(value)
}

function isStringRecord(
  value: JsonValue
): value is { [key: string]: string } {
  return (
    isRecord(value) &&
    Object.keys(value).length <= 64 &&
    Object.entries(value).every(
      ([key, entry]) =>
        key.length > 0 &&
        key.length <= 128 &&
        typeof entry === 'string' &&
        entry.length <= 8_192
    )
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
      value.every((entry) => isJsonValue(entry, depth + 1))
    )
  }
  if (!isRecord(value) || Object.keys(value).length > 1_000) {
    return false
  }
  return Object.values(value).every((entry) =>
    isJsonValue(entry, depth + 1)
  )
}

function cloneJsonRecord(
  value: Record<string, JsonValue>
): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>
}

function jsonByteLength(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function safeJson(value: JsonValue): string {
  return truncate(JSON.stringify(value), 1_000)
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum
    ? value
    : `${value.slice(0, maximum - 1)}…`
}

function compareDefinitions(
  left: StrategyDefinition,
  right: StrategyDefinition
): number {
  return left.manifest.id.localeCompare(right.manifest.id)
}

function isRecord(
  value: unknown
): value is Record<string, JsonValue | undefined> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
