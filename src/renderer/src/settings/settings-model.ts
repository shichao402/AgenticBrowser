import type {
  CapabilityPolicy,
  CapabilitySettings,
  ContentFilterCssRule,
  ContentFilterDefinition,
  ContentFilterNetworkRule,
  ContentFilterResourceType,
  JsonValue,
  ProjectDraft,
  ProjectRuntimeMode,
  ProjectSchedule,
  ProjectStrategyPin,
  StrategyFrameScope,
  StrategyManifest,
  StrategyPermission,
  StrategyRunAt,
  WorkflowFailureCategory,
  WorkflowNode
} from '../../../shared/contracts'

/**
 * 草稿 ↔ 表单值 的纯函数转换层。
 *
 * 设置页只操作 `ProjectForm` / `StrategyForm`，提交前再转回共享契约里的
 * `ProjectDraft` / `StrategyManifest`。所有单位换算（毫秒↔分钟、字节↔MiB）
 * 都收在这一层，避免 UI 组件里散落 `* 1024 * 1024` 之类的魔法数字。
 *
 * 本文件不依赖 React，也不产生副作用，可以直接被单元测试覆盖。
 */

/** 表单里表示时长/容量的可编辑数值，允许用户输入临时非法内容。 */
export type NumericText = string

export const MINUTE_MS = 60_000
export const MIB_BYTES = 1024 * 1024

export const RUNTIME_MODE_OPTIONS: Array<{
  value: ProjectRuntimeMode
  label: string
  hint: string
}> = [
  {
    value: 'manual',
    label: '手动',
    hint: '只能由「启动」按钮触发，不自动运行'
  },
  {
    value: 'autostart',
    label: '随应用启动',
    hint: '应用启动后自动运行一次'
  },
  {
    value: 'resident',
    label: '常驻',
    hint: '结束后自动重新排队，长期占用工作队列'
  },
  {
    value: 'schedule',
    label: '定时',
    hint: '按每日时间点或固定间隔触发'
  }
]

export const SCHEDULE_KIND_OPTIONS: Array<{
  value: ProjectSchedule['kind']
  label: string
}> = [
  { value: 'daily', label: '每日时间点' },
  { value: 'interval', label: '固定间隔' }
]

export const COMMON_TIMEZONES: string[] = [
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Tokyo',
  'Asia/Singapore',
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles'
]

export const RESOURCE_TYPE_OPTIONS: Array<{
  value: ContentFilterResourceType
  label: string
}> = [
  { value: 'stylesheet', label: '样式表' },
  { value: 'image', label: '图片' },
  { value: 'media', label: '音视频' },
  { value: 'font', label: '字体' },
  { value: 'script', label: '脚本' },
  { value: 'xhr', label: 'XHR / Fetch' },
  { value: 'other', label: '其他' }
]

export const WORKFLOW_FAILURE_CATEGORIES: WorkflowFailureCategory[] = [
  'network',
  'timeout',
  'authentication',
  'page-changed',
  'renderer',
  'disk',
  'cancelled',
  'unknown'
]

export const WORKFLOW_FAILURE_LABELS: Record<WorkflowFailureCategory, string> =
  {
    network: '网络',
    timeout: '超时',
    authentication: '鉴权',
    'page-changed': '页面变化',
    renderer: '渲染进程',
    disk: '磁盘',
    cancelled: '已取消',
    unknown: '未知'
  }

export type WorkflowNodeKind = WorkflowNode['kind']

export const WORKFLOW_NODE_KINDS: Array<{
  value: WorkflowNodeKind
  label: string
  hint: string
}> = [
  {
    value: 'navigate',
    label: '打开页面',
    hint: '导航到指定 URL，然后进入下一节点'
  },
  {
    value: 'wait-for-event',
    label: '等待事件',
    hint: '等待策略或宿主发出指定事件后再继续'
  },
  { value: 'delay', label: '延时', hint: '等待固定时长后进入下一节点' },
  { value: 'complete', label: '完成', hint: '结束本次运行，无下一节点' }
]

export const STRATEGY_RUN_AT_OPTIONS: Array<{
  value: StrategyRunAt
  label: string
  hint: string
}> = [
  {
    value: 'document-start',
    label: 'document-start',
    hint: '文档开始解析前注入'
  },
  { value: 'document-end', label: 'document-end', hint: 'DOM 解析完成后注入' },
  {
    value: 'document-idle',
    label: 'document-idle',
    hint: '页面空闲后注入（推荐）'
  }
]

export const STRATEGY_FRAME_OPTIONS: Array<{
  value: StrategyFrameScope
  label: string
  hint: string
}> = [
  { value: 'top', label: '仅主框架', hint: '只在顶层页面注入' },
  { value: 'all', label: '包含子框架', hint: '同时对匹配的 iframe 注入' }
]

export const STRATEGY_PERMISSION_OPTIONS: Array<{
  value: StrategyPermission
  label: string
  hint: string
}> = [
  {
    value: 'dom.read',
    label: 'dom.read',
    hint: '读取页面 DOM。声明与审计用途，不构成强制隔离'
  },
  {
    value: 'dom.write',
    label: 'dom.write',
    hint: '修改页面 DOM。声明与审计用途，不构成强制隔离'
  },
  {
    value: 'dom.click',
    label: 'dom.click',
    hint: '触发页面点击。声明与审计用途，不构成强制隔离'
  },
  {
    value: 'config.read',
    label: 'config.read',
    hint: '解锁宿主下发的 manifest.config 读取能力'
  },
  {
    value: 'log',
    label: 'log',
    hint: '输出结构化日志到事件流'
  },
  {
    value: 'project.emit-event',
    label: 'project.emit-event',
    hint: '解锁向 Project Workflow 发送领域事件的能力'
  },
  {
    value: 'network.request',
    label: 'network.request',
    hint: '解锁经宿主代理发起网络请求的能力'
  },
  {
    value: 'main-world',
    label: 'main-world',
    hint: '解锁在页面主世界执行代码的能力'
  }
]

export const CAPABILITY_KEYS: Array<keyof CapabilitySettings> = [
  'popups',
  'downloads',
  'notifications',
  'geolocation',
  'media',
  'clipboardRead',
  'fullscreen'
]

export type CapabilityDecision = 'inherit' | 'allow' | 'deny'

export interface OriginFormRule {
  origin: string
  /** 每个能力项的覆盖决策；`inherit` 等价于未声明覆盖。 */
  overrides: Record<keyof CapabilitySettings, CapabilityDecision>
}

export interface NetworkRuleForm {
  id: string
  action: 'allow' | 'block'
  urlPattern: string
  resourceTypes: ContentFilterResourceType[]
}

export interface CssRuleForm {
  id: string
  urlPattern: string
  selectorsText: string
}

export interface FilterForm {
  enabled: boolean
  networkRules: NetworkRuleForm[]
  cssRules: CssRuleForm[]
}

export interface ProjectBaseForm {
  id: string
  name: string
  profileId: string
  startupPagesText: string
  enabled: boolean
}

export interface ProjectRuntimeForm {
  mode: ProjectRuntimeMode
  timezone: string
  scheduleKind: ProjectSchedule['kind']
  dailyTimesText: string
  everyMinutesText: NumericText
  priorityText: NumericText
  maxRunMsText: NumericText
}

export interface ProjectOutputForm {
  root: string
  maxBytesText: NumericText
  fileNameTemplate: string
}

export interface ProjectRetryForm {
  maxConsecutiveFailuresText: NumericText
  baseBackoffMsText: NumericText
  maxBackoffMsText: NumericText
}

export interface CapabilityOriginForm {
  origin: string
  overrides: Record<keyof CapabilitySettings, CapabilityDecision>
}

export interface CapabilityForm {
  defaults: CapabilitySettings
  origins: CapabilityOriginForm[]
}

export interface StrategyPinForm {
  id: string
  version: string
}

export interface WorkflowNodeForm {
  id: string
  kind: WorkflowNodeKind
  url: string
  eventName: string
  delayMsText: NumericText
  next: string
  timeoutMsText: NumericText
  maxAttemptsText: NumericText
  checkpoint: boolean
  idempotencyKey: string
  /** 与 `WORKFLOW_FAILURE_CATEGORIES` 对齐的失败目标节点列表。 */
  onFailure: Partial<Record<WorkflowFailureCategory, string>>
}

export interface WorkflowForm {
  versionText: NumericText
  entryNodeId: string
  nodes: WorkflowNodeForm[]
}

export interface ProjectForm {
  base: ProjectBaseForm
  runtime: ProjectRuntimeForm
  workflow: WorkflowForm
  output: ProjectOutputForm
  capabilities: CapabilityForm
  filter: FilterForm
  retry: ProjectRetryForm
  strategies: StrategyPinForm[]
}

export interface StrategyConfigEntryForm {
  key: string
  /** 值的文本表示；`type` 决定解析方式。 */
  type: 'string' | 'number' | 'boolean' | 'json'
  valueText: string
}

export interface StrategyManifestForm {
  id: string
  name: string
  version: string
  matchesText: string
  excludesText: string
  networkMatchesText: string
  runAt: StrategyRunAt
  frames: StrategyFrameScope
  permissions: StrategyPermission[]
  config: StrategyConfigEntryForm[]
  startupMsText: NumericText
  heartbeatMsText: NumericText
}

export interface StrategyForm {
  manifest: StrategyManifestForm
  source: string
}

function joinLines(values: string[]): string {
  return values.join('\n')
}

function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function numberToText(value: number): NumericText {
  return Number.isFinite(value) ? String(value) : ''
}

function textToNumber(text: NumericText, fallback: number): number {
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function msToMinutesText(ms: number): NumericText {
  return numberToText(Math.round((ms / MINUTE_MS) * 1000) / 1000)
}

export function minutesTextToMs(text: NumericText, fallback: number): number {
  const parsed = Number(text)
  return Number.isFinite(parsed) ? Math.round(parsed * MINUTE_MS) : fallback
}

export function bytesToMibText(bytes: number): NumericText {
  return numberToText(Math.round((bytes / MIB_BYTES) * 100) / 100)
}

export function mibTextToBytes(text: NumericText, fallback: number): number {
  const parsed = Number(text)
  return Number.isFinite(parsed) ? Math.round(parsed * MIB_BYTES) : fallback
}

function toDecision(value: boolean | undefined): CapabilityDecision {
  if (value === undefined) {
    return 'inherit'
  }
  return value ? 'allow' : 'deny'
}

function fromDecision(decision: CapabilityDecision): boolean | undefined {
  if (decision === 'inherit') {
    return undefined
  }
  return decision === 'allow'
}

function createOverrideRecord(): Record<
  keyof CapabilitySettings,
  CapabilityDecision
> {
  return CAPABILITY_KEYS.reduce(
    (acc, key) => {
      acc[key] = 'inherit'
      return acc
    },
    {} as Record<keyof CapabilitySettings, CapabilityDecision>
  )
}

export function capabilityPolicyToForm(
  policy: CapabilityPolicy
): CapabilityForm {
  return {
    defaults: { ...policy.defaults },
    origins: policy.origins.map((rule) => {
      const overrides = createOverrideRecord()
      for (const key of CAPABILITY_KEYS) {
        overrides[key] = toDecision(rule.overrides[key])
      }
      return { origin: rule.origin, overrides }
    })
  }
}

export function capabilityFormToPolicy(form: CapabilityForm): CapabilityPolicy {
  return {
    schemaVersion: 1,
    defaults: { ...form.defaults },
    origins: form.origins
      .filter((rule) => rule.origin.trim().length > 0)
      .map((rule) => {
        const overrides: Partial<CapabilitySettings> = {}
        for (const key of CAPABILITY_KEYS) {
          const value = fromDecision(rule.overrides[key])
          if (value !== undefined) {
            overrides[key] = value
          }
        }
        return { origin: rule.origin.trim(), overrides }
      })
      .filter((rule) => Object.keys(rule.overrides).length > 0)
  }
}

export function filterToForm(filter: ContentFilterDefinition): FilterForm {
  return {
    enabled: filter.enabled,
    networkRules: filter.networkRules.map((rule) => ({
      id: rule.id,
      action: rule.action,
      urlPattern: rule.urlPattern,
      resourceTypes: [...rule.resourceTypes]
    })),
    cssRules: filter.cssRules.map((rule) => ({
      id: rule.id,
      urlPattern: rule.urlPattern,
      selectorsText: joinLines(rule.selectors)
    }))
  }
}

export function filterFormToDefinition(
  form: FilterForm
): ContentFilterDefinition {
  return {
    enabled: form.enabled,
    networkRules: form.networkRules
      .filter((rule) => rule.id.trim().length > 0)
      .map<ContentFilterNetworkRule>((rule) => ({
        id: rule.id.trim(),
        action: rule.action,
        urlPattern: rule.urlPattern.trim(),
        resourceTypes: [...rule.resourceTypes]
      })),
    cssRules: form.cssRules
      .filter((rule) => rule.id.trim().length > 0)
      .map<ContentFilterCssRule>((rule) => ({
        id: rule.id.trim(),
        urlPattern: rule.urlPattern.trim(),
        selectors: splitLines(rule.selectorsText)
      }))
  }
}

export function workflowNodeToForm(node: WorkflowNode): WorkflowNodeForm {
  return {
    id: node.id,
    kind: node.kind,
    url: node.kind === 'navigate' ? node.url : '',
    eventName: node.kind === 'wait-for-event' ? node.eventName : '',
    delayMsText: node.kind === 'delay' ? numberToText(node.delayMs) : '1000',
    next: node.kind === 'complete' ? '' : node.next,
    timeoutMsText: numberToText(node.timeoutMs),
    maxAttemptsText: numberToText(node.maxAttempts),
    checkpoint: node.checkpoint,
    idempotencyKey: node.idempotencyKey ?? '',
    onFailure: { ...(node.onFailure ?? {}) }
  }
}

/**
 * 把表单节点转回契约节点。
 *
 * 只有当前 `kind` 的专属字段会被写入，其余类型的专属字段必须丢弃，
 * 否则主进程校验会因为出现多余字段而失败。
 */
export function workflowNodeFormToNode(form: WorkflowNodeForm): WorkflowNode {
  const base = {
    id: form.id.trim(),
    timeoutMs: textToNumber(form.timeoutMsText, 30_000),
    maxAttempts: Math.max(1, Math.round(textToNumber(form.maxAttemptsText, 1))),
    checkpoint: form.checkpoint,
    ...(form.idempotencyKey.trim().length > 0
      ? { idempotencyKey: form.idempotencyKey.trim() }
      : {}),
    ...(Object.keys(form.onFailure).length > 0
      ? { onFailure: { ...form.onFailure } }
      : {})
  }

  switch (form.kind) {
    case 'navigate':
      return {
        ...base,
        kind: 'navigate',
        url: form.url.trim(),
        next: form.next
      }
    case 'wait-for-event':
      return {
        ...base,
        kind: 'wait-for-event',
        eventName: form.eventName.trim(),
        next: form.next
      }
    case 'delay':
      return {
        ...base,
        kind: 'delay',
        delayMs: Math.max(0, Math.round(textToNumber(form.delayMsText, 0))),
        next: form.next
      }
    case 'complete':
    default:
      return { ...base, kind: 'complete' }
  }
}

/**
 * 切换节点类型时保留公共字段与各类型已输入的专属字段。
 *
 * 需求 3.4 要求切换 `kind` 不丢失公共字段；这里额外保留专属字段的草稿值，
 * 让用户来回切换时不必重填。真正写盘时由 `workflowNodeFormToNode` 裁剪。
 */
export function switchWorkflowNodeKind(
  form: WorkflowNodeForm,
  kind: WorkflowNodeKind
): WorkflowNodeForm {
  return { ...form, kind }
}

export function createWorkflowNodeForm(
  kind: WorkflowNodeKind,
  existingIds: string[]
): WorkflowNodeForm {
  let index = existingIds.length + 1
  let id = `node-${index}`
  while (existingIds.includes(id)) {
    index += 1
    id = `node-${index}`
  }
  return {
    id,
    kind,
    url: 'https://example.com/',
    eventName: 'project.complete',
    delayMsText: '1000',
    next: '',
    timeoutMsText: '30000',
    maxAttemptsText: '1',
    checkpoint: true,
    idempotencyKey: '',
    onFailure: {}
  }
}

export function createOriginFormRule(): CapabilityOriginForm {
  return { origin: '', overrides: createOverrideRecord() }
}

export function createNetworkRuleForm(existingIds: string[]): NetworkRuleForm {
  let index = existingIds.length + 1
  let id = `network-${index}`
  while (existingIds.includes(id)) {
    index += 1
    id = `network-${index}`
  }
  return { id, action: 'block', urlPattern: '*', resourceTypes: [] }
}

export function createCssRuleForm(existingIds: string[]): CssRuleForm {
  let index = existingIds.length + 1
  let id = `css-${index}`
  while (existingIds.includes(id)) {
    index += 1
    id = `css-${index}`
  }
  return { id, urlPattern: '*', selectorsText: '' }
}

export function createStrategyConfigEntry(): StrategyConfigEntryForm {
  return { key: '', type: 'string', valueText: '' }
}

export function projectToForm(draft: ProjectDraft): ProjectForm {
  const schedule = draft.runtime.schedule
  return {
    base: {
      id: draft.id,
      name: draft.name,
      profileId: draft.profileId,
      startupPagesText: joinLines(draft.startupPages),
      enabled: draft.enabled
    },
    runtime: {
      mode: draft.runtime.mode,
      timezone: draft.runtime.timezone,
      scheduleKind: schedule?.kind ?? 'daily',
      dailyTimesText:
        schedule?.kind === 'daily' ? joinLines(schedule.times) : '09:00',
      everyMinutesText:
        schedule?.kind === 'interval'
          ? numberToText(schedule.everyMinutes)
          : '60',
      priorityText: numberToText(draft.runtime.priority),
      maxRunMsText: msToMinutesText(draft.runtime.maxRunMs)
    },
    workflow: {
      versionText: numberToText(draft.workflow.version),
      entryNodeId: draft.workflow.entryNodeId,
      nodes: draft.workflow.nodes.map(workflowNodeToForm)
    },
    output: {
      root: draft.output.root,
      maxBytesText: bytesToMibText(draft.output.maxBytes),
      fileNameTemplate: draft.output.fileNameTemplate
    },
    capabilities: capabilityPolicyToForm(draft.capabilities),
    filter: filterToForm(draft.filter),
    retry: {
      maxConsecutiveFailuresText: numberToText(
        draft.retry.maxConsecutiveFailures
      ),
      baseBackoffMsText: numberToText(draft.retry.baseBackoffMs),
      maxBackoffMsText: numberToText(draft.retry.maxBackoffMs)
    },
    strategies: draft.strategies.map((pin) => ({ ...pin }))
  }
}

export function formToProject(
  form: ProjectForm,
  fallback: ProjectDraft
): ProjectDraft {
  const runtime = {
    mode: form.runtime.mode,
    timezone: form.runtime.timezone.trim(),
    priority: Math.round(textToNumber(form.runtime.priorityText, 0)),
    maxRunMs: minutesTextToMs(
      form.runtime.maxRunMsText,
      fallback.runtime.maxRunMs
    ),
    ...(form.runtime.mode === 'schedule'
      ? {
          schedule:
            form.runtime.scheduleKind === 'daily'
              ? {
                  kind: 'daily' as const,
                  times: splitLines(form.runtime.dailyTimesText)
                }
              : {
                  kind: 'interval' as const,
                  everyMinutes: Math.max(
                    1,
                    Math.round(textToNumber(form.runtime.everyMinutesText, 60))
                  )
                }
        }
      : {})
  }

  return {
    id: form.base.id.trim(),
    name: form.base.name.trim(),
    profileId: form.base.profileId,
    startupPages: splitLines(form.base.startupPagesText),
    strategies: form.strategies
      .filter((pin) => pin.id.trim().length > 0)
      .map<ProjectStrategyPin>((pin) => ({
        id: pin.id.trim(),
        version: pin.version.trim()
      })),
    runtime,
    workflow: {
      version: Math.max(
        1,
        Math.round(textToNumber(form.workflow.versionText, 1))
      ),
      entryNodeId: form.workflow.entryNodeId,
      nodes: form.workflow.nodes.map(workflowNodeFormToNode)
    },
    output: {
      root: form.output.root.trim(),
      maxBytes: mibTextToBytes(
        form.output.maxBytesText,
        fallback.output.maxBytes
      ),
      fileNameTemplate: form.output.fileNameTemplate.trim()
    },
    capabilities: capabilityFormToPolicy(form.capabilities),
    filter: filterFormToDefinition(form.filter),
    retry: {
      maxConsecutiveFailures: Math.max(
        0,
        Math.round(textToNumber(form.retry.maxConsecutiveFailuresText, 5))
      ),
      baseBackoffMs: Math.max(
        0,
        Math.round(textToNumber(form.retry.baseBackoffMsText, 1_000))
      ),
      maxBackoffMs: Math.max(
        0,
        Math.round(textToNumber(form.retry.maxBackoffMsText, 60_000))
      )
    },
    enabled: form.base.enabled
  }
}

function jsonValueToConfigEntry(
  key: string,
  value: JsonValue
): StrategyConfigEntryForm {
  if (typeof value === 'string') {
    return { key, type: 'string', valueText: value }
  }
  if (typeof value === 'number') {
    return { key, type: 'number', valueText: String(value) }
  }
  if (typeof value === 'boolean') {
    return { key, type: 'boolean', valueText: value ? 'true' : 'false' }
  }
  return { key, type: 'json', valueText: JSON.stringify(value, null, 2) }
}

export function strategyToForm(
  manifest: StrategyManifest,
  source: string
): StrategyForm {
  return {
    manifest: {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      matchesText: joinLines(manifest.matches),
      excludesText: joinLines(manifest.excludes),
      networkMatchesText: joinLines(manifest.networkMatches),
      runAt: manifest.runAt,
      frames: manifest.frames,
      permissions: [...manifest.permissions],
      config: Object.entries(manifest.config).map(([key, value]) =>
        jsonValueToConfigEntry(key, value)
      ),
      startupMsText: numberToText(manifest.timeouts.startupMs),
      heartbeatMsText: numberToText(manifest.timeouts.heartbeatMs)
    },
    source
  }
}

/**
 * 把表单里的 config 键值对解析成 `Record<string, JsonValue>`。
 *
 * 解析失败项会被跳过并计入 `errors`，由校验层转成字段级错误，避免
 * 一个坏值导致整份配置无法提交时没有任何线索。
 */
export function parseStrategyConfig(entries: StrategyConfigEntryForm[]): {
  config: Record<string, JsonValue>
  errors: Record<number, string>
} {
  const config: Record<string, JsonValue> = {}
  const errors: Record<number, string> = {}

  entries.forEach((entry, index) => {
    const key = entry.key.trim()
    if (key.length === 0) {
      errors[index] = '键名不能为空'
      return
    }
    switch (entry.type) {
      case 'string':
        config[key] = entry.valueText
        return
      case 'number': {
        const parsed = Number(entry.valueText)
        if (!Number.isFinite(parsed)) {
          errors[index] = '请输入合法数字'
          return
        }
        config[key] = parsed
        return
      }
      case 'boolean': {
        const normalized = entry.valueText.trim().toLowerCase()
        if (normalized !== 'true' && normalized !== 'false') {
          errors[index] = '请填写 true 或 false'
          return
        }
        config[key] = normalized === 'true'
        return
      }
      case 'json':
      default: {
        try {
          config[key] = JSON.parse(entry.valueText) as JsonValue
        } catch {
          errors[index] = 'JSON 解析失败'
        }
      }
    }
  })

  return { config, errors }
}

export function formToStrategy(
  form: StrategyForm,
  fallback: StrategyManifest
): StrategyManifest {
  const { config } = parseStrategyConfig(form.manifest.config)
  return {
    id: form.manifest.id.trim(),
    name: form.manifest.name.trim(),
    version: form.manifest.version.trim(),
    matches: splitLines(form.manifest.matchesText),
    excludes: splitLines(form.manifest.excludesText),
    runAt: form.manifest.runAt,
    frames: form.manifest.frames,
    permissions: [...form.manifest.permissions],
    networkMatches: splitLines(form.manifest.networkMatchesText),
    config,
    timeouts: {
      startupMs: Math.max(
        0,
        Math.round(
          textToNumber(form.manifest.startupMsText, fallback.timeouts.startupMs)
        )
      ),
      heartbeatMs: Math.max(
        1,
        Math.round(
          textToNumber(
            form.manifest.heartbeatMsText,
            fallback.timeouts.heartbeatMs
          )
        )
      )
    }
  }
}

/** 精确 Origin：协议 + 主机 + 可选端口，不允许路径、通配符或查询串。 */
export function isExactOrigin(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return false
  }
  if (trimmed.includes('*')) {
    return false
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false
  }
  return parsed.origin === trimmed
}

export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** 表单里引用了但当前不存在的节点 ID，用于悬空引用检测。 */
export function findDanglingNodeReferences(form: WorkflowForm): Array<{
  from: string
  to: string
  field: string
}> {
  const ids = new Set(form.nodes.map((node) => node.id.trim()))
  const dangling: Array<{ from: string; to: string; field: string }> = []

  if (form.entryNodeId.length > 0 && !ids.has(form.entryNodeId)) {
    dangling.push({
      from: 'entryNodeId',
      to: form.entryNodeId,
      field: 'entryNodeId'
    })
  }

  form.nodes.forEach((node) => {
    if (
      node.kind !== 'complete' &&
      node.next.length > 0 &&
      !ids.has(node.next)
    ) {
      dangling.push({ from: node.id, to: node.next, field: `${node.id}.next` })
    }
    for (const [category, target] of Object.entries(node.onFailure)) {
      if (target && !ids.has(target)) {
        dangling.push({
          from: node.id,
          to: target,
          field: `${node.id}.onFailure.${category}`
        })
      }
    }
  })

  return dangling
}

/** 找出所有引用了指定节点 ID 的来源，用于阻止误删。 */
export function findNodeReferences(
  form: WorkflowForm,
  nodeId: string
): string[] {
  const sources: string[] = []
  if (form.entryNodeId === nodeId) {
    sources.push('入口节点')
  }
  form.nodes.forEach((node) => {
    if (node.id === nodeId) {
      return
    }
    if (node.kind !== 'complete' && node.next === nodeId) {
      sources.push(`${node.id} 的下一跳`)
    }
    for (const [category, target] of Object.entries(node.onFailure)) {
      if (target === nodeId) {
        sources.push(
          `${node.id} 的失败处理（${WORKFLOW_FAILURE_LABELS[category as WorkflowFailureCategory] ?? category}）`
        )
      }
    }
  })
  return sources
}

/**
 * 重命名节点 ID 并同步所有引用（`next`、`entryNodeId`、`onFailure`）。
 *
 * 需求 3.8 允许「同步更新」或「提示确认」，同步更新对用户更友好，
 * 也让图结构在编辑过程中始终自洽。
 */
export function renameWorkflowNode(
  form: WorkflowForm,
  oldId: string,
  newId: string
): WorkflowForm {
  const trimmed = newId.trim()
  if (trimmed.length === 0 || trimmed === oldId) {
    return form
  }
  return {
    ...form,
    entryNodeId: form.entryNodeId === oldId ? trimmed : form.entryNodeId,
    nodes: form.nodes.map((node) => {
      const onFailure = { ...node.onFailure }
      for (const key of WORKFLOW_FAILURE_CATEGORIES) {
        if (onFailure[key] === oldId) {
          onFailure[key] = trimmed
        }
      }
      return {
        ...node,
        id: node.id === oldId ? trimmed : node.id,
        next:
          node.kind !== 'complete' && node.next === oldId ? trimmed : node.next,
        onFailure
      }
    })
  }
}
