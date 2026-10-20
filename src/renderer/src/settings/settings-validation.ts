import type {
  ProjectDraft,
  StrategyManifest,
  StrategyWorkspaceSnapshot,
  WorkflowFailureCategory
} from '../../../shared/contracts'
import type { ProjectForm, StrategyForm, WorkflowForm } from './settings-model'
import {
  WORKFLOW_FAILURE_CATEGORIES,
  findDanglingNodeReferences,
  isExactOrigin,
  isHttpUrl,
  parseStrategyConfig
} from './settings-model'

/**
 * 设置页的字段级校验。
 *
 * 输出是以字段路径为键的扁平错误表（例如 `workflow.nodes.1.url`），
 * 视图层用同一套路径去渲染字段错误、标注分区与跳转到首个错误。
 * 纯函数、无副作用，可独立单测。
 */

export type ValidationIssue = {
  path: string
  message: string
}

export type ValidationResult = {
  /** 字段路径 → 首条错误文案。 */
  errors: Record<string, string>
  /** 按出现顺序排列的完整错误列表，供摘要展示与跳转。 */
  issues: ValidationIssue[]
}

export type ProjectSectionKey =
  | 'base'
  | 'runtime'
  | 'workflow'
  | 'output'
  | 'capabilities'
  | 'filter'
  | 'retry'
  | 'strategies'

class IssueCollector {
  private readonly issues: ValidationIssue[] = []

  add(path: string, message: string): void {
    this.issues.push({ path, message })
  }

  result(): ValidationResult {
    const errors: Record<string, string> = {}
    for (const issue of this.issues) {
      if (!(issue.path in errors)) {
        errors[issue.path] = issue.message
      }
    }
    return { errors, issues: [...this.issues] }
  }
}

function isBlank(value: string): boolean {
  return value.trim().length === 0
}

function checkPositiveNumber(
  collector: IssueCollector,
  path: string,
  text: string,
  label: string,
  options: { min?: number; integer?: boolean } = {}
): void {
  if (isBlank(text)) {
    collector.add(path, `${label}不能为空`)
    return
  }
  const value = Number(text)
  if (!Number.isFinite(value)) {
    collector.add(path, `${label}必须是数字`)
    return
  }
  if (options.integer && !Number.isInteger(value)) {
    collector.add(path, `${label}必须是整数`)
    return
  }
  if (options.min !== undefined && value < options.min) {
    collector.add(path, `${label}不能小于 ${options.min}`)
  }
}

function validateTimeText(
  collector: IssueCollector,
  path: string,
  value: string
): void {
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(value)) {
    collector.add(path, '时间格式应为 HH:mm，例如 09:30')
  }
}

function validateWorkflow(
  collector: IssueCollector,
  workflow: ProjectForm['workflow']
): void {
  checkPositiveNumber(
    collector,
    'workflow.version',
    workflow.versionText,
    'Workflow 版本',
    { min: 1, integer: true }
  )

  if (workflow.nodes.length === 0) {
    collector.add('workflow.nodes', '至少需要一个节点')
    return
  }

  const seenIds = new Set<string>()
  workflow.nodes.forEach((node, index) => {
    const prefix = `workflow.nodes.${index}`
    if (isBlank(node.id)) {
      collector.add(`${prefix}.id`, '节点 ID 不能为空')
    } else if (seenIds.has(node.id.trim())) {
      collector.add(`${prefix}.id`, `节点 ID ${node.id.trim()} 重复`)
    } else {
      seenIds.add(node.id.trim())
    }

    checkPositiveNumber(
      collector,
      `${prefix}.timeoutMs`,
      node.timeoutMsText,
      '超时',
      { min: 1, integer: true }
    )
    checkPositiveNumber(
      collector,
      `${prefix}.maxAttempts`,
      node.maxAttemptsText,
      '最大尝试次数',
      { min: 1, integer: true }
    )

    if (node.kind === 'navigate') {
      if (isBlank(node.url)) {
        collector.add(`${prefix}.url`, 'URL 不能为空')
      } else if (!isHttpUrl(node.url)) {
        collector.add(`${prefix}.url`, 'URL 必须以 http:// 或 https:// 开头')
      }
    }

    if (node.kind === 'wait-for-event' && isBlank(node.eventName)) {
      collector.add(`${prefix}.eventName`, '事件名不能为空')
    }

    if (node.kind === 'delay') {
      checkPositiveNumber(
        collector,
        `${prefix}.delayMs`,
        node.delayMsText,
        '延时',
        {
          min: 0,
          integer: true
        }
      )
    }

    if (node.kind !== 'complete' && isBlank(node.next)) {
      collector.add(`${prefix}.next`, '请选择下一节点')
    }
  })

  if (isBlank(workflow.entryNodeId)) {
    collector.add('workflow.entryNodeId', '请选择入口节点')
  } else if (
    !workflow.nodes.some((node) => node.id.trim() === workflow.entryNodeId)
  ) {
    collector.add('workflow.entryNodeId', '入口节点不在当前节点列表中')
  }

  const dangling = findDanglingNodeReferences(workflow)
  for (const reference of dangling) {
    if (reference.field === 'entryNodeId') {
      continue
    }
    const [nodeId, , ...rest] = reference.field.split('.')
    const index = workflow.nodes.findIndex((node) => node.id === nodeId)
    if (index < 0) {
      continue
    }
    const key = rest.length > 0 ? rest.join('.') : 'next'
    collector.add(
      `workflow.nodes.${index}.${key}`,
      `引用了不存在的节点 ${reference.to}`
    )
  }
}

export function validateProjectForm(form: ProjectForm): ValidationResult {
  const collector = new IssueCollector()

  if (isBlank(form.base.id)) {
    collector.add('base.id', 'Project ID 不能为空')
  } else if (!/^[a-zA-Z0-9._-]+$/.test(form.base.id.trim())) {
    collector.add('base.id', 'ID 只能包含字母、数字、点、下划线与连字符')
  }
  if (isBlank(form.base.name)) {
    collector.add('base.name', 'Project 名称不能为空')
  }
  if (isBlank(form.base.profileId)) {
    collector.add('base.profileId', '请选择 Profile')
  }

  const startupPages = form.base.startupPagesText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (startupPages.length === 0) {
    collector.add('base.startupPages', '至少需要一个启动页面')
  }
  startupPages.forEach((page, index) => {
    if (!isHttpUrl(page)) {
      collector.add(`base.startupPages.${index}`, '启动页面必须是 http(s) URL')
    }
  })

  if (isBlank(form.runtime.timezone)) {
    collector.add('runtime.timezone', '请选择时区')
  } else {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: form.runtime.timezone })
    } catch {
      collector.add('runtime.timezone', '无法识别的时区')
    }
  }

  if (form.runtime.mode === 'schedule') {
    if (form.runtime.scheduleKind === 'daily') {
      const times = form.runtime.dailyTimesText
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
      if (times.length === 0) {
        collector.add('runtime.dailyTimes', '至少需要一个时间点')
      }
      times.forEach((time, index) => {
        validateTimeText(collector, `runtime.dailyTimes.${index}`, time)
      })
    } else {
      checkPositiveNumber(
        collector,
        'runtime.everyMinutes',
        form.runtime.everyMinutesText,
        '间隔分钟数',
        { min: 1, integer: true }
      )
    }
  }

  checkPositiveNumber(
    collector,
    'runtime.priority',
    form.runtime.priorityText,
    '优先级',
    { integer: true }
  )
  checkPositiveNumber(
    collector,
    'runtime.maxRunMs',
    form.runtime.maxRunMsText,
    '最长运行时长（分钟）',
    { min: 1 }
  )

  validateWorkflow(collector, form.workflow)

  if (isBlank(form.output.root)) {
    collector.add('output.root', '输出目录不能为空')
  }
  checkPositiveNumber(
    collector,
    'output.maxBytes',
    form.output.maxBytesText,
    '单文件容量（MiB）',
    { min: 1 }
  )
  if (isBlank(form.output.fileNameTemplate)) {
    collector.add('output.fileNameTemplate', '文件命名模板不能为空')
  }

  form.capabilities.origins.forEach((rule, index) => {
    if (isBlank(rule.origin)) {
      collector.add(`capabilities.origins.${index}.origin`, 'Origin 不能为空')
      return
    }
    if (!isExactOrigin(rule.origin)) {
      collector.add(
        `capabilities.origins.${index}.origin`,
        '必须填写精确 Origin（协议 + 主机 + 端口），不支持路径与通配符'
      )
    }
  })

  form.filter.networkRules.forEach((rule, index) => {
    if (isBlank(rule.id)) {
      collector.add(`filter.networkRules.${index}.id`, '规则 ID 不能为空')
    }
    if (isBlank(rule.urlPattern)) {
      collector.add(
        `filter.networkRules.${index}.urlPattern`,
        'URL 模式不能为空'
      )
    }
    if (rule.resourceTypes.length === 0) {
      collector.add(
        `filter.networkRules.${index}.resourceTypes`,
        '请至少选择一种资源类型'
      )
    }
  })

  form.filter.cssRules.forEach((rule, index) => {
    if (isBlank(rule.id)) {
      collector.add(`filter.cssRules.${index}.id`, '规则 ID 不能为空')
    }
    if (isBlank(rule.urlPattern)) {
      collector.add(`filter.cssRules.${index}.urlPattern`, 'URL 模式不能为空')
    }
    if (isBlank(rule.selectorsText)) {
      collector.add(`filter.cssRules.${index}.selectors`, '至少需要一个选择器')
    }
  })

  checkPositiveNumber(
    collector,
    'retry.maxConsecutiveFailures',
    form.retry.maxConsecutiveFailuresText,
    '最大连续失败次数',
    { min: 0, integer: true }
  )
  checkPositiveNumber(
    collector,
    'retry.baseBackoffMs',
    form.retry.baseBackoffMsText,
    '基础退避',
    { min: 0, integer: true }
  )
  checkPositiveNumber(
    collector,
    'retry.maxBackoffMs',
    form.retry.maxBackoffMsText,
    '最大退避',
    { min: 0, integer: true }
  )
  const baseBackoff = Number(form.retry.baseBackoffMsText)
  const maxBackoff = Number(form.retry.maxBackoffMsText)
  if (
    Number.isFinite(baseBackoff) &&
    Number.isFinite(maxBackoff) &&
    baseBackoff > maxBackoff
  ) {
    collector.add('retry.baseBackoffMs', '基础退避不能大于最大退避')
  }

  const pinIds = new Set<string>()
  form.strategies.forEach((pin, index) => {
    if (isBlank(pin.id)) {
      collector.add(`strategies.${index}.id`, '请选择策略')
      return
    }
    if (pinIds.has(pin.id.trim())) {
      collector.add(`strategies.${index}.id`, `策略 ${pin.id.trim()} 重复固定`)
      return
    }
    pinIds.add(pin.id.trim())
    if (isBlank(pin.version)) {
      collector.add(`strategies.${index}.version`, '请填写固定版本')
    }
  })

  return collector.result()
}

/** 源码语法检查：解析为函数体，不执行。 */
export function checkStrategySourceSyntax(source: string): string | null {
  try {
    new Function('agenticStrategy', source)
    return null
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }
}

export function validateStrategyForm(
  form: StrategyForm,
  options: { registryVersions?: Map<string, string> } = {}
): ValidationResult {
  const collector = new IssueCollector()
  const manifest = form.manifest

  if (isBlank(manifest.id)) {
    collector.add('manifest.id', 'Strategy ID 不能为空')
  } else if (!/^[a-zA-Z0-9._-]+$/.test(manifest.id.trim())) {
    collector.add('manifest.id', 'ID 只能包含字母、数字、点、下划线与连字符')
  }
  if (isBlank(manifest.name)) {
    collector.add('manifest.name', 'Strategy 名称不能为空')
  }
  if (isBlank(manifest.version)) {
    collector.add('manifest.version', '版本号不能为空')
  }

  const matches = manifest.matchesText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (matches.length === 0) {
    collector.add('manifest.matches', '至少填写一条匹配模式')
  }

  if (manifest.permissions.length === 0) {
    collector.add('manifest.permissions', '至少声明一项权限')
  }

  const { errors: configErrors } = parseStrategyConfig(manifest.config)
  for (const [index, message] of Object.entries(configErrors)) {
    collector.add(`manifest.config.${index}`, message)
  }
  const configKeys = new Set<string>()
  manifest.config.forEach((entry, index) => {
    const key = entry.key.trim()
    if (key.length === 0) {
      return
    }
    if (configKeys.has(key)) {
      collector.add(`manifest.config.${index}.key`, `键名 ${key} 重复`)
    }
    configKeys.add(key)
  })

  checkPositiveNumber(
    collector,
    'manifest.startupMs',
    manifest.startupMsText,
    '启动超时',
    { min: 1, integer: true }
  )
  checkPositiveNumber(
    collector,
    'manifest.heartbeatMs',
    manifest.heartbeatMsText,
    '心跳间隔',
    { min: 1, integer: true }
  )

  const registryVersions = options.registryVersions
  if (registryVersions) {
    const registered = registryVersions.get(manifest.id.trim())
    if (
      registered !== undefined &&
      registryVersions.has(manifest.id.trim()) &&
      manifest.version.trim().length > 0 &&
      registered !== manifest.version.trim()
    ) {
      // 版本不一致只是提示，不阻断保存（需求 4.6）。
    }
  }

  const syntaxError = checkStrategySourceSyntax(form.source)
  if (syntaxError) {
    collector.add('source', `源码语法错误：${syntaxError}`)
  }

  return collector.result()
}

/**
 * 把校验错误映射到分区，用于在分区导航上标红。
 */
export function projectErrorSections(
  result: ValidationResult
): Set<ProjectSectionKey> {
  const sections = new Set<ProjectSectionKey>()
  for (const issue of result.issues) {
    const head = issue.path.split('.')[0]
    if (head === 'base' || head === 'profileId') {
      sections.add('base')
    } else if (head === 'runtime') {
      sections.add('runtime')
    } else if (head === 'workflow') {
      sections.add('workflow')
    } else if (head === 'output') {
      sections.add('output')
    } else if (head === 'capabilities') {
      sections.add('capabilities')
    } else if (head === 'filter') {
      sections.add('filter')
    } else if (head === 'retry') {
      sections.add('retry')
    } else if (head === 'strategies') {
      sections.add('strategies')
    }
  }
  return sections
}

export function firstErrorPath(result: ValidationResult): string | null {
  const first = result.issues[0]
  return first ? first.path : null
}

/** 字段路径 → DOM 元素 id，供 `scrollIntoView` 定位（需求 7.3）。 */
export function fieldAnchorId(path: string): string {
  return `field-${path.replace(/[^a-zA-Z0-9]+/g, '-')}`
}

export function buildRegistryVersionMap(
  workspace: StrategyWorkspaceSnapshot | null
): Map<string, string> {
  const map = new Map<string, string>()
  for (const definition of workspace?.strategies ?? []) {
    map.set(definition.manifest.id, definition.manifest.version)
  }
  return map
}

/**
 * 主进程错误 → 设置页内联提示。
 *
 * 主进程返回的是整条字符串（如校验异常信息），这里不再猜测字段位置，
 * 只负责把它归到当前编辑对象，避免像以前一样只写在工作台工具栏。
 */
export function describeSaveError(
  cause: unknown,
  target: { kind: 'project'; id: string } | { kind: 'strategy'; id: string }
): ValidationIssue[] {
  const message = cause instanceof Error ? cause.message : String(cause)
  const label = target.kind === 'project' ? 'Project' : 'Strategy'
  return [
    { path: 'save', message: `${label} ${target.id} 保存失败：${message}` }
  ]
}

export function isWorkflowCategory(
  value: string
): value is WorkflowFailureCategory {
  return (WORKFLOW_FAILURE_CATEGORIES as string[]).includes(value)
}

/** 供外部复用：把草稿转成人类可读的引用摘要。 */
export function summarizeDangling(workflow: WorkflowForm): string[] {
  return findDanglingNodeReferences(workflow).map(
    (reference) => `${reference.from} → ${reference.to}`
  )
}

export type { ProjectDraft, StrategyManifest }
