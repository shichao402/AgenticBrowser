import { randomUUID } from 'node:crypto'
import { rename } from 'node:fs/promises'
import { isAbsolute, posix, win32 } from 'node:path'

import type {
  ContentFilterCssRule,
  ContentFilterDefinition,
  ContentFilterNetworkRule,
  ContentFilterResourceType,
  ProjectDefinition,
  ProjectDraft,
  ProjectRuntimeMode,
  ProjectRuntimeSettings,
  ProjectSchedule,
  ProjectStrategyPin,
  ProjectWorkflowDefinition,
  WorkflowFailureCategory,
  WorkflowNode,
  WorkflowNodeBase
} from '../shared/contracts'
import { isNodeError, readJsonFile, writeJsonAtomic } from './atomic-file'
import {
  cloneCapabilityPolicy,
  parseCapabilityPolicy
} from './capability-store'
import { isValidStrategyMatchPattern } from './strategy-match'

export interface ProjectState {
  schemaVersion: 1
  activeProjectId: string | null
  projects: ProjectDefinition[]
}

const PROJECT_ID = /^[a-z][a-z0-9-]{0,63}$/
const PROFILE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/
const STRATEGY_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/
const WORKFLOW_ID = /^[a-z][a-z0-9-]{0,79}$/
const EVENT_NAME = /^[a-z][a-z0-9.-]{0,79}$/
const FILTER_RULE_ID = /^[a-z][a-z0-9-]{0,63}$/
const RUNTIME_MODES = new Set<ProjectRuntimeMode>([
  'manual',
  'autostart',
  'resident',
  'schedule'
])
const FAILURE_CATEGORIES = new Set<WorkflowFailureCategory>([
  'network',
  'timeout',
  'authentication',
  'page-changed',
  'renderer',
  'disk',
  'cancelled',
  'unknown'
])
const FILTER_RESOURCE_TYPES = new Set<ContentFilterResourceType>([
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'xhr',
  'other'
])

export class ProjectStore {
  private queue = Promise.resolve()

  constructor(readonly filePath: string) {}

  async read(): Promise<ProjectState> {
    let value: unknown | null
    try {
      value = await readJsonFile(this.filePath)
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error
      }
      await this.quarantineInvalidFile()
      return emptyProjectState()
    }

    if (value === null) {
      return emptyProjectState()
    }
    const state = parseProjectState(value)
    if (state) {
      return state
    }
    await this.quarantineInvalidFile()
    return emptyProjectState()
  }

  async save(value: unknown): Promise<ProjectState> {
    const draft = parseProjectDraft(value)
    if (!draft) {
      throw new Error('Project 定义格式无效')
    }
    return this.update((state) => {
      const existing = state.projects.find((project) => project.id === draft.id)
      const now = new Date().toISOString()
      const definition: ProjectDefinition = {
        ...draft,
        capabilities: cloneCapabilityPolicy(draft.capabilities),
        revision: (existing?.revision ?? 0) + 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      }
      return {
        schemaVersion: 1,
        activeProjectId: state.activeProjectId ?? definition.id,
        projects: [
          ...state.projects.filter((project) => project.id !== definition.id),
          definition
        ].sort(compareProjects)
      }
    })
  }

  async setActive(projectId: string): Promise<ProjectState> {
    requireProjectId(projectId)
    return this.update((state) => {
      requireProject(state, projectId)
      return { ...state, activeProjectId: projectId }
    })
  }

  async delete(projectId: string): Promise<ProjectState> {
    requireProjectId(projectId)
    return this.update((state) => {
      requireProject(state, projectId)
      const projects = state.projects.filter(
        (project) => project.id !== projectId
      )
      return {
        schemaVersion: 1,
        activeProjectId:
          state.activeProjectId === projectId
            ? (projects[0]?.id ?? null)
            : state.activeProjectId,
        projects
      }
    })
  }

  private async update(
    transform: (state: ProjectState) => ProjectState
  ): Promise<ProjectState> {
    let result: ProjectState | null = null
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

export function emptyProjectState(): ProjectState {
  return {
    schemaVersion: 1,
    activeProjectId: null,
    projects: []
  }
}

export function parseProjectState(value: unknown): ProjectState | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'activeProjectId', 'projects']) ||
    value.schemaVersion !== 1 ||
    (value.activeProjectId !== null &&
      typeof value.activeProjectId !== 'string') ||
    !Array.isArray(value.projects) ||
    value.projects.length > 128
  ) {
    return null
  }

  const ids = new Set<string>()
  const projects: ProjectDefinition[] = []
  for (const candidate of value.projects) {
    const project = parseProjectDefinition(candidate)
    if (!project || ids.has(project.id)) {
      return null
    }
    ids.add(project.id)
    projects.push(project)
  }
  if (
    (projects.length === 0 && value.activeProjectId !== null) ||
    (typeof value.activeProjectId === 'string' &&
      !ids.has(value.activeProjectId))
  ) {
    return null
  }
  projects.sort(compareProjects)
  return {
    schemaVersion: 1,
    activeProjectId: value.activeProjectId,
    projects
  }
}

export function parseProjectDraft(value: unknown): ProjectDraft | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'id',
      'name',
      'profileId',
      'startupPages',
      'strategies',
      'runtime',
      'workflow',
      'output',
      'capabilities',
      'filter',
      'retry',
      'enabled'
    ]) ||
    typeof value.id !== 'string' ||
    !PROJECT_ID.test(value.id) ||
    typeof value.name !== 'string' ||
    value.name.trim().length === 0 ||
    value.name.trim().length > 100 ||
    typeof value.profileId !== 'string' ||
    !PROFILE_ID.test(value.profileId) ||
    !isHttpUrlArray(value.startupPages, 1, 8) ||
    !Array.isArray(value.strategies) ||
    value.strategies.length > 64 ||
    typeof value.enabled !== 'boolean'
  ) {
    return null
  }

  const strategies = parseStrategyPins(value.strategies)
  const runtime = parseRuntimeSettings(value.runtime)
  const workflow = parseWorkflow(value.workflow)
  const output = parseOutput(value.output)
  const capabilities = parseCapabilityPolicy(value.capabilities)
  const filter = parseContentFilter(value.filter)
  const retry = parseRetry(value.retry)
  if (
    !strategies ||
    !runtime ||
    !workflow ||
    !output ||
    !capabilities ||
    !filter ||
    !retry
  ) {
    return null
  }

  return {
    id: value.id,
    name: value.name.trim(),
    profileId: value.profileId,
    startupPages: [...value.startupPages] as string[],
    strategies,
    runtime,
    workflow,
    output,
    capabilities,
    filter,
    retry,
    enabled: value.enabled
  }
}

export function parseProjectDefinition(
  value: unknown
): ProjectDefinition | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'id',
      'name',
      'profileId',
      'startupPages',
      'strategies',
      'runtime',
      'workflow',
      'output',
      'capabilities',
      'filter',
      'retry',
      'enabled',
      'revision',
      'createdAt',
      'updatedAt'
    ])
  ) {
    return null
  }
  const draft = parseProjectDraft({
    id: value.id,
    name: value.name,
    profileId: value.profileId,
    startupPages: value.startupPages,
    strategies: value.strategies,
    runtime: value.runtime,
    workflow: value.workflow,
    output: value.output,
    capabilities: value.capabilities,
    filter: value.filter,
    retry: value.retry,
    enabled: value.enabled
  })
  if (
    !draft ||
    !isIntegerBetween(value.revision, 1, Number.MAX_SAFE_INTEGER) ||
    !isIsoDate(value.createdAt) ||
    !isIsoDate(value.updatedAt)
  ) {
    return null
  }
  return {
    ...draft,
    revision: value.revision as number,
    createdAt: value.createdAt as string,
    updatedAt: value.updatedAt as string
  }
}

function parseStrategyPins(value: unknown[]): ProjectStrategyPin[] | null {
  const pins: ProjectStrategyPin[] = []
  const ids = new Set<string>()
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ['id', 'version']) ||
      typeof candidate.id !== 'string' ||
      !PROJECT_ID.test(candidate.id) ||
      typeof candidate.version !== 'string' ||
      !STRATEGY_VERSION.test(candidate.version) ||
      ids.has(candidate.id)
    ) {
      return null
    }
    ids.add(candidate.id)
    pins.push({ id: candidate.id, version: candidate.version })
  }
  return pins.sort((left, right) => left.id.localeCompare(right.id))
}

function parseRuntimeSettings(value: unknown): ProjectRuntimeSettings | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'mode',
      'timezone',
      'schedule',
      'priority',
      'maxRunMs'
    ]) ||
    !hasRequiredKeys(value, ['mode', 'timezone', 'priority', 'maxRunMs']) ||
    typeof value.mode !== 'string' ||
    !RUNTIME_MODES.has(value.mode as ProjectRuntimeMode) ||
    typeof value.timezone !== 'string' ||
    !isValidTimezone(value.timezone) ||
    !isIntegerBetween(value.priority, -100, 100) ||
    !isIntegerBetween(value.maxRunMs, 1_000, 7 * 24 * 60 * 60 * 1_000)
  ) {
    return null
  }

  const schedule =
    value.schedule === undefined ? undefined : parseSchedule(value.schedule)
  if (
    (value.mode === 'schedule' && !schedule) ||
    (value.mode !== 'schedule' && value.schedule !== undefined)
  ) {
    return null
  }
  return {
    mode: value.mode as ProjectRuntimeMode,
    timezone: value.timezone,
    ...(schedule ? { schedule } : {}),
    priority: value.priority as number,
    maxRunMs: value.maxRunMs as number
  }
}

function parseSchedule(value: unknown): ProjectSchedule | null {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return null
  }
  if (
    value.kind === 'daily' &&
    hasExactKeys(value, ['kind', 'times']) &&
    Array.isArray(value.times) &&
    value.times.length > 0 &&
    value.times.length <= 24 &&
    value.times.every(
      (time) =>
        typeof time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)
    ) &&
    new Set(value.times).size === value.times.length
  ) {
    return { kind: 'daily', times: [...value.times].sort() as string[] }
  }
  if (
    value.kind === 'interval' &&
    hasExactKeys(value, ['kind', 'everyMinutes']) &&
    isIntegerBetween(value.everyMinutes, 1, 7 * 24 * 60)
  ) {
    return {
      kind: 'interval',
      everyMinutes: value.everyMinutes as number
    }
  }
  return null
}

function parseWorkflow(value: unknown): ProjectWorkflowDefinition | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'entryNodeId', 'nodes']) ||
    !isIntegerBetween(value.version, 1, Number.MAX_SAFE_INTEGER) ||
    typeof value.entryNodeId !== 'string' ||
    !WORKFLOW_ID.test(value.entryNodeId) ||
    !Array.isArray(value.nodes) ||
    value.nodes.length === 0 ||
    value.nodes.length > 128
  ) {
    return null
  }

  const nodes: WorkflowNode[] = []
  const ids = new Set<string>()
  for (const candidate of value.nodes) {
    const node = parseWorkflowNode(candidate)
    if (!node || ids.has(node.id)) {
      return null
    }
    ids.add(node.id)
    nodes.push(node)
  }
  if (
    !ids.has(value.entryNodeId) ||
    !nodes.some((node) => node.kind === 'complete')
  ) {
    return null
  }
  for (const node of nodes) {
    if ('next' in node && !ids.has(node.next)) {
      return null
    }
    if (
      node.onFailure &&
      Object.values(node.onFailure).some((target) => !ids.has(target))
    ) {
      return null
    }
  }
  return {
    version: value.version as number,
    entryNodeId: value.entryNodeId,
    nodes
  }
}

function parseWorkflowNode(value: unknown): WorkflowNode | null {
  if (
    !isRecord(value) ||
    typeof value.kind !== 'string' ||
    !['navigate', 'wait-for-event', 'delay', 'complete'].includes(value.kind)
  ) {
    return null
  }
  const common = parseWorkflowNodeBase(value)
  if (!common) {
    return null
  }
  const baseKeys = [
    'id',
    'kind',
    'timeoutMs',
    'maxAttempts',
    'checkpoint',
    'idempotencyKey',
    'onFailure'
  ]
  if (
    value.kind === 'navigate' &&
    hasOnlyKeys(value, [...baseKeys, 'url', 'next']) &&
    typeof value.url === 'string' &&
    isHttpUrl(value.url) &&
    typeof value.next === 'string' &&
    WORKFLOW_ID.test(value.next)
  ) {
    return { ...common, kind: 'navigate', url: value.url, next: value.next }
  }
  if (
    value.kind === 'wait-for-event' &&
    hasOnlyKeys(value, [...baseKeys, 'eventName', 'next']) &&
    typeof value.eventName === 'string' &&
    EVENT_NAME.test(value.eventName) &&
    typeof value.next === 'string' &&
    WORKFLOW_ID.test(value.next)
  ) {
    return {
      ...common,
      kind: 'wait-for-event',
      eventName: value.eventName,
      next: value.next
    }
  }
  if (
    value.kind === 'delay' &&
    hasOnlyKeys(value, [...baseKeys, 'delayMs', 'next']) &&
    isIntegerBetween(value.delayMs, 1, 24 * 60 * 60 * 1_000) &&
    typeof value.next === 'string' &&
    WORKFLOW_ID.test(value.next)
  ) {
    return {
      ...common,
      kind: 'delay',
      delayMs: value.delayMs as number,
      next: value.next
    }
  }
  if (value.kind === 'complete' && hasOnlyKeys(value, baseKeys)) {
    return { ...common, kind: 'complete' }
  }
  return null
}

function parseWorkflowNodeBase(
  value: Record<string, unknown>
): WorkflowNodeBase | null {
  if (
    typeof value.id !== 'string' ||
    !WORKFLOW_ID.test(value.id) ||
    !isIntegerBetween(value.timeoutMs, 100, 24 * 60 * 60 * 1_000) ||
    !isIntegerBetween(value.maxAttempts, 1, 20) ||
    typeof value.checkpoint !== 'boolean' ||
    (value.idempotencyKey !== undefined &&
      (typeof value.idempotencyKey !== 'string' ||
        value.idempotencyKey.length === 0 ||
        value.idempotencyKey.length > 200)) ||
    !parseFailureTransitions(value.onFailure)
  ) {
    return null
  }
  return {
    id: value.id,
    timeoutMs: value.timeoutMs as number,
    maxAttempts: value.maxAttempts as number,
    checkpoint: value.checkpoint,
    ...(typeof value.idempotencyKey === 'string'
      ? { idempotencyKey: value.idempotencyKey }
      : {}),
    ...(value.onFailure === undefined
      ? {}
      : {
          onFailure: {
            ...(value.onFailure as Partial<
              Record<WorkflowFailureCategory, string>
            >)
          }
        })
  }
}

function parseFailureTransitions(
  value: unknown
): value is Partial<Record<WorkflowFailureCategory, string>> | undefined {
  if (value === undefined) {
    return true
  }
  return (
    isRecord(value) &&
    Object.keys(value).length > 0 &&
    Object.entries(value).every(
      ([category, target]) =>
        FAILURE_CATEGORIES.has(category as WorkflowFailureCategory) &&
        typeof target === 'string' &&
        WORKFLOW_ID.test(target)
    )
  )
}

function parseOutput(value: unknown): ProjectDraft['output'] | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['root', 'maxBytes', 'fileNameTemplate']) ||
    typeof value.root !== 'string' ||
    value.root.trim() !== value.root ||
    !isCrossPlatformAbsolute(value.root) ||
    !isIntegerBetween(value.maxBytes, 1024 * 1024, 10 * 1024 ** 4) ||
    typeof value.fileNameTemplate !== 'string' ||
    value.fileNameTemplate.length === 0 ||
    value.fileNameTemplate.length > 200 ||
    // 有意匹配 ASCII 控制字符，拒绝含不可见字符的文件名模板
    // eslint-disable-next-line no-control-regex
    /[/\\\u0000-\u001f]/.test(value.fileNameTemplate)
  ) {
    return null
  }
  return {
    root: value.root,
    maxBytes: value.maxBytes as number,
    fileNameTemplate: value.fileNameTemplate
  }
}

function parseRetry(value: unknown): ProjectDraft['retry'] | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'maxConsecutiveFailures',
      'baseBackoffMs',
      'maxBackoffMs'
    ]) ||
    !isIntegerBetween(value.maxConsecutiveFailures, 1, 100) ||
    !isIntegerBetween(value.baseBackoffMs, 100, 60 * 60 * 1_000) ||
    !isIntegerBetween(value.maxBackoffMs, 100, 24 * 60 * 60 * 1_000) ||
    (value.baseBackoffMs as number) > (value.maxBackoffMs as number)
  ) {
    return null
  }
  return {
    maxConsecutiveFailures: value.maxConsecutiveFailures as number,
    baseBackoffMs: value.baseBackoffMs as number,
    maxBackoffMs: value.maxBackoffMs as number
  }
}

function parseContentFilter(value: unknown): ContentFilterDefinition | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['enabled', 'networkRules', 'cssRules']) ||
    typeof value.enabled !== 'boolean' ||
    !Array.isArray(value.networkRules) ||
    value.networkRules.length > 512 ||
    !Array.isArray(value.cssRules) ||
    value.cssRules.length > 256
  ) {
    return null
  }

  const networkRules: ContentFilterNetworkRule[] = []
  const cssRules: ContentFilterCssRule[] = []
  const ids = new Set<string>()
  for (const candidate of value.networkRules) {
    const rule = parseNetworkRule(candidate)
    if (!rule || ids.has(rule.id)) {
      return null
    }
    ids.add(rule.id)
    networkRules.push(rule)
  }
  for (const candidate of value.cssRules) {
    const rule = parseCssRule(candidate)
    if (!rule || ids.has(rule.id)) {
      return null
    }
    ids.add(rule.id)
    cssRules.push(rule)
  }
  return { enabled: value.enabled, networkRules, cssRules }
}

function parseNetworkRule(value: unknown): ContentFilterNetworkRule | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['id', 'action', 'urlPattern', 'resourceTypes']) ||
    typeof value.id !== 'string' ||
    !FILTER_RULE_ID.test(value.id) ||
    (value.action !== 'allow' && value.action !== 'block') ||
    typeof value.urlPattern !== 'string' ||
    !isValidStrategyMatchPattern(value.urlPattern) ||
    !Array.isArray(value.resourceTypes) ||
    value.resourceTypes.length === 0 ||
    value.resourceTypes.length > FILTER_RESOURCE_TYPES.size ||
    !value.resourceTypes.every(
      (entry) =>
        typeof entry === 'string' &&
        FILTER_RESOURCE_TYPES.has(entry as ContentFilterResourceType)
    ) ||
    new Set(value.resourceTypes).size !== value.resourceTypes.length
  ) {
    return null
  }
  return {
    id: value.id,
    action: value.action,
    urlPattern: value.urlPattern,
    resourceTypes: [...value.resourceTypes] as ContentFilterResourceType[]
  }
}

function parseCssRule(value: unknown): ContentFilterCssRule | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['id', 'urlPattern', 'selectors']) ||
    typeof value.id !== 'string' ||
    !FILTER_RULE_ID.test(value.id) ||
    typeof value.urlPattern !== 'string' ||
    !isValidStrategyMatchPattern(value.urlPattern) ||
    !Array.isArray(value.selectors) ||
    value.selectors.length === 0 ||
    value.selectors.length > 256 ||
    !value.selectors.every(
      (selector) =>
        typeof selector === 'string' &&
        selector.trim() === selector &&
        selector.length > 0 &&
        selector.length <= 500 &&
        !selector.includes('</style')
    )
  ) {
    return null
  }
  return {
    id: value.id,
    urlPattern: value.urlPattern,
    selectors: [...value.selectors] as string[]
  }
}

function isHttpUrlArray(
  value: unknown,
  minimum: number,
  maximum: number
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= minimum &&
    value.length <= maximum &&
    value.every((entry) => typeof entry === 'string' && isHttpUrl(entry)) &&
    new Set(value).size === value.length
  )
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.toString() === value
    )
  } catch {
    return false
  }
}

function isValidTimezone(value: string): boolean {
  if (value.length === 0 || value.length > 100) {
    return false
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}

function isCrossPlatformAbsolute(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value) || posix.isAbsolute(value)
}

function requireProjectId(projectId: string): void {
  if (!PROJECT_ID.test(projectId)) {
    throw new Error('Project ID 格式无效')
  }
}

function requireProject(
  state: ProjectState,
  projectId: string
): ProjectDefinition {
  const project = state.projects.find((candidate) => candidate.id === projectId)
  if (!project) {
    throw new Error(`Project 不存在：${projectId}`)
  }
  return project
}

function compareProjects(
  left: ProjectDefinition,
  right: ProjectDefinition
): number {
  return left.id.localeCompare(right.id)
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

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: string[]
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
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
