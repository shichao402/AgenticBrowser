// 手动维护：从类型真源汇总「合法标识符集合」
//
// 校验器用该集合判断文档中出现的反引号标识符是否真实存在。
// 集合内容全部来自源码解析，不手工维护名单。

import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  REPO_ROOT,
  SOURCE_FILES,
  readConstObjectKeys,
  readDiscriminatedUnionKinds,
  readInjectedStrategyMembers,
  readInterfaceMembers,
  readInvokedHostMethods,
  readNumericConstant,
  readThrownErrorMessages,
  readUnionLiterals
} from './type-source.mjs'

/**
 * 尝试读取接口成员，不存在则返回 null。
 */
function tryReadInterface(name) {
  try {
    return readInterfaceMembers(name)
  } catch {
    return null
  }
}

/**
 * 尝试读取联合类型字面量，不存在或含非字面量成员则返回 null。
 */
function tryReadUnion(name) {
  try {
    return readUnionLiterals(name)
  } catch {
    return null
  }
}

// 需要纳入标识符校验的联合类型。
export const VALIDATED_UNION_TYPES = [
  'BrowserEventType',
  'StrategyRunAt',
  'StrategyFrameScope',
  'StrategyPermission',
  'StrategyLogLevel',
  'StrategyHostMethod',
  'StrategyRuntimeStatus',
  'StrategyRuntimeSignalType',
  'WorkflowFailureCategory',
  'ProjectRuntimeMode',
  'ProjectRuntimeStatus',
  'DownloadRecordStatus',
  'PageHealthStatus',
  'ContentFilterResourceType',
  'ProjectStrategyResolutionStatus',
  'JsonValue'
]

// 需要展开字段的接口，除两个主 API 外还包含常用的数据模型。
export const FIELD_INTERFACES = [
  'BrowserShellApi',
  'StrategyHostApi',
  'BrowserEvent',
  'BrowserSnapshot',
  'BrowserTab',
  'MonitorSnapshot',
  'ProfileSummary',
  'CapabilitySettings',
  'CapabilityPolicy',
  'CapabilityPolicySnapshot',
  'OriginCapabilityRule',
  'ProjectDefinition',
  'ProjectDraft',
  'ProjectWorkspaceSnapshot',
  'ProjectRuntimeSettings',
  'ProjectSchedule',
  'ProjectStrategyPin',
  'ProjectOutputSettings',
  'ProjectRetryPolicy',
  'ProjectRuntimeRecord',
  'ProjectRuntimeCounters',
  'ProjectStrategyResolution',
  'ProjectWorkflowDefinition',
  'ProjectDownloadRecord',
  'StrategyManifest',
  'StrategyDefinition',
  'StrategyDraft',
  'StrategyWorkspaceSnapshot',
  'StrategyRuntimeSnapshot',
  'StrategyRuntimeEntrySnapshot',
  'StrategyNetworkRequest',
  'StrategyNetworkResponse',
  'StartupSettings',
  'RecoverySnapshot',
  'PageHealthSnapshot',
  'ProcessMetric',
  'DownloadSummary',
  'WorkflowNodeBase',
  'ContentFilterDefinition',
  'ContentFilterNetworkRule',
  'ContentFilterCssRule',
  'AutomationPlaygroundInstallResult'
]

/**
 * 构建标识符知识库，返回分类集合。
 */
export function buildIdentifierUniverse() {
  const methods = new Set()
  const types = new Set()
  const events = new Set()
  const permissions = new Set()
  const enumMembers = new Set()
  const fields = new Set()

  for (const interfaceName of FIELD_INTERFACES) {
    types.add(interfaceName)
    const declaration = tryReadInterface(interfaceName)
    if (!declaration) {
      // 可能是联合类型别名，例如 ProjectSchedule。
      const union = tryReadUnion(interfaceName)
      if (union) {
        for (const literal of union.literals) {
          const value = literal.value.replace(/^['"]|['"]$/gu, '')
          enumMembers.add(value)
        }
        continue
      }
      // 既不是接口也不是字面量联合，仍作为类型名登记，但不展开字段。
      continue
    }
    for (const member of declaration.members) {
      fields.add(member.name)
      if (interfaceName === 'BrowserShellApi' && member.kind === 'method') {
        methods.add(member.name)
      }
      if (interfaceName === 'StrategyHostApi') {
        // 宿主成员名同时计入方法集合，方便正文引用。
        methods.add(member.name)
      }
      // 返回类型中出现的项目内类型名也纳入类型集合。
      for (const name of extractTypeNames(member.returnType)) {
        types.add(name)
      }
      for (const parameter of member.parameters) {
        for (const name of extractTypeNames(parameter.type)) {
          types.add(name)
        }
      }
    }
  }

  for (const typeName of VALIDATED_UNION_TYPES) {
    if (typeName === 'JsonValue') {
      types.add(typeName)
      continue
    }
    const declaration = readUnionLiterals(typeName)
    types.add(typeName)
    for (const literal of declaration.literals) {
      const value = literal.value.replace(/^['"]|['"]$/gu, '')
      enumMembers.add(value)
      if (typeName === 'BrowserEventType') {
        events.add(value)
      }
      if (typeName === 'StrategyPermission') {
        permissions.add(value)
      }
    }
  }

  const workflowKinds = readDiscriminatedUnionKinds('WorkflowNode')
  types.add('WorkflowNode')
  for (const kind of workflowKinds.kinds) {
    enumMembers.add(kind.value)
  }

  types.add('IPC_CHANNELS')
  for (const key of readConstObjectKeys('IPC_CHANNELS').keys) {
    fields.add(key.name)
  }
  types.add('STRATEGY_IPC_CHANNELS')
  for (const key of readConstObjectKeys('STRATEGY_IPC_CHANNELS').keys) {
    fields.add(key.name)
  }

  // 限额常量名本身也是文档中会出现的标识符。
  const limitConstantNames = [
    'INSTALL_TIMEOUT_MS',
    'MAX_HOST_PAYLOAD_BYTES',
    'MAX_LOG_MESSAGE_LENGTH',
    'FIRST_STRATEGY_WORLD_ID'
  ]
  for (const name of limitConstantNames) {
    fields.add(name)
  }

  // 文档中会提到的关键运行时结构与宿主对象名称。
  for (const name of [
    'StrategyRuntime',
    'RecoveryEngine',
    'WebContentsView',
    'BrowserWindow',
    'contextBridge',
    'ipcRenderer',
    'exposeInMainWorld',
    'exposeInIsolatedWorld',
    'contextBridge.exposeInMainWorld',
    'contextBridge.exposeInIsolatedWorld'
  ]) {
    types.add(name)
  }

  // StrategyBootstrapEntry 等信封类型的字段，文档会以标识符形式引用。
  for (const envelope of ['StrategyBootstrapEntry', 'StrategyManifest']) {
    const declaration = tryReadInterface(envelope)
    if (declaration) {
      for (const member of declaration.members) {
        fields.add(member.name)
      }
    }
  }

  // 领域事件名来自源码中 emit 调用的字面量参数。
  for (const name of readEmittedDomainEvents()) {
    enumMembers.add(name)
  }

  // 宿主对象名与其成员访问形式，如 agenticStrategy.log。
  const hostNames = new Set(['agenticStrategy', 'window.agenticBrowser'])
  types.add('agenticStrategy')
  types.add('agenticBrowser')
  for (const member of methods) {
    hostNames.add(`agenticStrategy.${member}`)
    hostNames.add(`window.agenticBrowser.${member}`)
    hostNames.add(`agenticBrowser.${member}`)
  }

  for (const member of readInjectedStrategyMembers()) {
    methods.add(member.name)
  }
  for (const method of readInvokedHostMethods()) {
    methods.add(method)
  }

  return {
    methods,
    types,
    events,
    permissions,
    enumMembers,
    fields,
    hostNames
  }
}

/**
 * 从类型表达式中提取可能的项目内类型名。
 */
export function extractTypeNames(typeText) {
  const names = new Set()
  const matches = typeText.matchAll(/\b([A-Z][A-Za-z0-9]*)\b/gu)
  for (const match of matches) {
    names.add(match[1])
  }
  // 排除 TypeScript 内置类型
  for (const builtin of [
    'Promise',
    'Record',
    'Partial',
    'Readonly',
    'Array',
    'Map',
    'Set'
  ]) {
    names.delete(builtin)
  }
  return names
}

/**
 * 汇总源码中出现的静态错误文案，用于校验文档是否编造错误。
 */
export function buildErrorTexts() {
  const texts = new Set()
  for (const file of [
    SOURCE_FILES.strategyRuntime,
    SOURCE_FILES.strategyBootstrap
  ]) {
    for (const entry of readThrownErrorMessages(file)) {
      texts.add(entry.text)
    }
  }
  return texts
}

/**
 * 从源码文本中提取 `agenticStrategy.emit('name', ...)` 的事件名。
 * 这些是 Strategy 与主进程约定的领域事件，属于公开契约的一部分。
 */
function readEmittedDomainEvents() {
  const names = new Set()
  const files = [
    'src/main/smoke-fixtures.ts',
    'src/main/automation-playground-pilot.ts',
    'src/main/project-download-fault-smoke.ts',
    'src/main/project-download-recovery-smoke.ts'
  ]
  for (const file of files) {
    let text
    try {
      text = readFileSync(path.join(REPO_ROOT, file), 'utf8')
    } catch {
      continue
    }
    const pattern = /agenticStrategy\.emit\(\s*'([a-z][a-z0-9.-]*)'/gu
    let match
    while ((match = pattern.exec(text)) !== null) {
      names.add(match[1])
    }
  }
  return names
}

export { readNumericConstant }
