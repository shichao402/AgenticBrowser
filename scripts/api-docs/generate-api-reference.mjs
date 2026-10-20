// 手动维护：API 参考生成器
//
// 从类型真源生成 references/api-reference.md。
// 所有签名、字段、枚举、权限映射、限额与错误清单均由源码解析得出，
// 脚本内不硬编码任何 API 名称或数值。

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  REPO_ROOT,
  SKILL_ROOT,
  SOURCE_FILES,
  fail,
  getTypeScriptVersion,
  readConstObjectKeys,
  readDiscriminatedUnionKinds,
  readInjectedStrategyMembers,
  readInterfaceMembers,
  readInvokedHostMethods,
  readNumericConstant,
  readThrownErrorMessages,
  readUnionLiterals
} from './lib/type-source.mjs'
import {
  codeBlock,
  composeDocument,
  heading,
  originMarker,
  table,
  wrapParagraph
} from './lib/markdown.mjs'

export const OUTPUT_RELATIVE_PATH = 'references/api-reference.md'

const SHELL_API = 'BrowserShellApi'
const HOST_API = 'StrategyHostApi'

// 需要生成字面量成员表的联合类型，按输出顺序排列。
const ENUM_TYPES = [
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
  'ContentFilterResourceType'
]

// 需要输出限额的数值常量，均从源码读取。
const LIMIT_CONSTANTS = [
  {
    name: 'INSTALL_TIMEOUT_MS',
    file: SOURCE_FILES.strategyRuntime,
    note: 'bootstrap 安装超时'
  },
  {
    name: 'MAX_HOST_PAYLOAD_BYTES',
    file: SOURCE_FILES.strategyRuntime,
    note: '宿主调用 payload 字节上限'
  },
  {
    name: 'MAX_LOG_MESSAGE_LENGTH',
    file: SOURCE_FILES.strategyRuntime,
    note: '日志消息与失败原因长度上限'
  },
  {
    name: 'FIRST_STRATEGY_WORLD_ID',
    file: SOURCE_FILES.strategyRuntime,
    note: 'Strategy 隔离 world 起始编号'
  }
]

// WorkflowNodeType 在源码中不存在独立联合类型别名，
// 节点类型由 WorkflowNode 可辨识联合的 kind 字段表达，
// 因此从该联合真实解析，而不是硬编码列表。

function resolveTypeSources() {
  return Object.values(SOURCE_FILES).map((file) => `- \`${file}\``)
}

/**
 * 输出一段散文，自动折行到 80 列。
 */
function paragraph(text) {
  return [...wrapParagraph(text), '']
}

/**
 * 源码位置用最小可辨识后缀表示，例如 `strategy-runtime.ts:24`，
 * 既能在表格中控制宽度，也能在全文中唯一定位（文件均位于 src 下）。
 */
function shortLocation(file, line) {
  return `\`${path.basename(file)}:${line}\``
}

function renderParameters(parameters) {
  if (parameters.length === 0) {
    return ['无参数。']
  }
  return table(
    ['参数', '类型', '可选'],
    parameters.map((parameter) => [
      `\`${parameter.name}\``,
      `\`${parameter.type}\``,
      parameter.optional ? '是' : '否'
    ])
  )
}

function renderSignature(member) {
  if (member.kind === 'property') {
    const prefix = member.readonly ? 'readonly ' : ''
    const optional = member.optional ? '?' : ''
    return `${prefix}${member.name}${optional}: ${member.returnType}`
  }
  const params = member.parameters
    .map((parameter) => {
      const optional = parameter.optional ? '?' : ''
      if (parameter.name.startsWith('...')) {
        return `${parameter.name}: ${parameter.type}`
      }
      return `${parameter.name}${optional}: ${parameter.type}`
    })
    .join(', ')
  return `${member.name}(${params}): ${member.returnType}`
}

/**
 * 从返回类型中提取项目内接口名，用于展开字段表。
 * 只处理 `Promise<X>` 与 `X` 两种形态。
 */
function extractInterfaceName(returnType) {
  const promiseMatch = /^Promise<(.+)>$/u.exec(returnType)
  const inner = promiseMatch ? promiseMatch[1] : returnType
  if (!/^[A-Z][A-Za-z0-9]*$/u.test(inner)) {
    return null
  }
  return inner
}

function renderFieldTable(interfaceName, generatedSections) {
  if (generatedSections.has(interfaceName)) {
    return null
  }
  let members
  try {
    members = readInterfaceMembers(interfaceName)
  } catch {
    // 该类型不是本项目 contracts 中的 interface，跳过展开。
    return null
  }
  generatedSections.add(interfaceName)
  return [
    heading(5, `字段表 \`${interfaceName}\``),
    '',
    ...table(
      ['字段', '类型', '可选'],
      members.members.map((member) => [
        `\`${member.name}\``,
        `\`${member.returnType}\``,
        member.optional ? '是' : '否'
      ])
    ),
    ''
  ]
}

function renderApiSection(apiName, title, intro, generatedSections) {
  const api = readInterfaceMembers(apiName)
  const lines = [
    heading(3, title),
    '',
    ...paragraph(intro),
    ...paragraph(`共 ${api.members.length} 个成员，按源码声明顺序排列。`)
  ]
  for (const member of api.members) {
    lines.push(heading(4, `\`${member.name}\``))
    lines.push('')
    lines.push(...codeBlock('typescript', renderSignature(member)))
    lines.push('')
    lines.push(`源码位置：\`${api.file}:${member.line}\``)
    lines.push('')
    if (member.kind === 'method') {
      lines.push(...renderParameters(member.parameters))
      lines.push('')
    }
    const interfaceName = extractInterfaceName(member.returnType)
    if (interfaceName) {
      const fieldTable = renderFieldTable(interfaceName, generatedSections)
      if (fieldTable) {
        lines.push(...fieldTable)
      }
    }
  }
  return lines
}

function renderEnumSection() {
  const lines = [heading(3, '联合类型与字面量'), '']
  for (const typeName of ENUM_TYPES) {
    const declaration = readUnionLiterals(typeName)
    lines.push(heading(4, `\`${typeName}\``))
    lines.push('')
    lines.push(`源码位置：\`${declaration.file}:${declaration.line}\``)
    lines.push('')
    lines.push(
      ...table(
        ['字面量', '源码行'],
        declaration.literals.map((literal) => [
          `\`${literal.value}\``,
          `${literal.line}`
        ])
      )
    )
    lines.push('')
  }
  return lines
}

function renderWorkflowNodeKinds() {
  const declaration = readDiscriminatedUnionKinds('WorkflowNode')
  const lines = [heading(4, '`WorkflowNode` 的 kind 取值'), '']
  lines.push(
    ...paragraph(
      '工作流节点类型由可辨识联合的 `kind` 字段表达，没有独立的联合类型别名。'
    )
  )
  lines.push(`源码位置：\`${declaration.file}:${declaration.line}\``)
  lines.push('')
  lines.push(
    ...table(
      ['kind', '源码行'],
      declaration.kinds.map((kind) => [`\`${kind.value}\``, `${kind.line}`])
    )
  )
  lines.push('')
  return lines
}

/**
 * 从 strategy-runtime.ts 的 switch 分支读取
 * 「宿主方法 → 所需权限」的校验关系。
 * 解析失败即报错，不静默跳过。
 */
function renderPermissionMatrix() {
  const source = readSourceText(SOURCE_FILES.strategyRuntime)
  const lines = [heading(3, '宿主方法所需权限'), '']
  const rows = []
  for (const method of readInvokedHostMethods()) {
    const pattern = new RegExp(
      `case '${method}':\\s*\\n\\s*this\\.requirePermission\\(lease, '([^']+)'\\)`,
      'u'
    )
    const match = pattern.exec(source)
    if (!match) {
      fail(
        `无法解析宿主方法 ${method} 的权限校验关系`,
        SOURCE_FILES.strategyRuntime
      )
    }
    rows.push([`\`${method}\``, `\`${match[1]}\``])
  }
  lines.push(
    ...paragraph(
      '权限来自 manifest 的 `permissions` 字段，未声明对应权限时调用会抛错。'
    )
  )
  lines.push(...table(['宿主方法', '所需权限'], rows))
  lines.push('')
  return lines
}

function readSourceText(relativePath) {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')
}

function renderLimits() {
  const lines = [heading(3, '限额常量'), '']
  lines.push(
    ...paragraph(
      '下列数值由源码常量读取，数值变更会导致校验失败，需要重新生成。'
    )
  )
  const rows = LIMIT_CONSTANTS.map((entry) => {
    const constant = readNumericConstant(entry.name, entry.file)
    return [
      `\`${constant.name}\``,
      `${constant.value}`,
      shortLocation(constant.file, constant.line)
    ]
  })
  lines.push(...table(['常量', '数值', '位置'], rows))
  lines.push('')
  lines.push('各常量含义：')
  lines.push('')
  for (const entry of LIMIT_CONSTANTS) {
    lines.push(...wrapParagraph(`- \`${entry.name}\`：${entry.note}`))
  }
  lines.push('')
  return lines
}

function renderErrors() {
  const lines = [heading(3, '显式错误文案'), '']
  lines.push(
    ...paragraph(
      '下列文案来自源码中的 `throw new Error(...)`，可用于识别失败原因。'
    )
  )
  lines.push(
    ...paragraph('含模板插值的文案无法逐字复述，仅给出位置与该文案的稳定前缀。')
  )
  const staticRows = []
  const templateRows = []
  for (const file of [
    SOURCE_FILES.strategyRuntime,
    SOURCE_FILES.strategyBootstrap
  ]) {
    for (const entry of readThrownErrorMessages(file)) {
      if (entry.text.includes('`')) {
        templateRows.push([entry.text, shortLocation(entry.file, entry.line)])
        continue
      }
      staticRows.push([
        `\`${entry.text}\``,
        shortLocation(entry.file, entry.line)
      ])
    }
  }
  lines.push(...table(['错误文案', '位置'], staticRows))
  if (templateRows.length > 0) {
    lines.push('')
    lines.push(heading(4, '含插值的文案'))
    lines.push('')
    for (const [text, location] of templateRows) {
      const prefix = text.split(/\$\{[^}]*\}/u)[0] ?? ''
      const cleanPrefix = prefix.replace(/`/gu, '').trim()
      lines.push(
        ...wrapParagraph(
          `- ${location}：以「${cleanPrefix}」开头，中间含动态值`
        )
      )
    }
  }
  lines.push('')
  return lines
}

function renderCoverageStats() {
  const shell = readInterfaceMembers(SHELL_API)
  const host = readInterfaceMembers(HOST_API)
  const channels = readConstObjectKeys('IPC_CHANNELS')
  const events = readUnionLiterals('BrowserEventType')
  const lines = [heading(3, '覆盖率统计'), '']
  lines.push(
    ...table(
      ['项目', '数量', '真源'],
      [
        [
          `\`${SHELL_API}\` 方法`,
          `${shell.members.length}`,
          `\`${shell.file}\``
        ],
        [`\`${HOST_API}\` 成员`, `${host.members.length}`, `\`${host.file}\``],
        [
          '`IPC_CHANNELS` 通道',
          `${channels.keys.length}`,
          `\`${channels.file}\``
        ],
        [
          '`BrowserEventType` 事件',
          `${events.literals.length}`,
          `\`${events.file}\``
        ]
      ]
    )
  )
  lines.push('')
  lines.push(
    ...paragraph(
      `渲染进程桥方法数与 IPC 通道数应相等，当前分别为 ${shell.members.length} 与 ${channels.keys.length}。`
    )
  )
  return lines
}

function renderEvents() {
  const events = readUnionLiterals('BrowserEventType')
  const lines = [heading(3, '`BrowserEventType` 事件'), '']
  lines.push(`源码位置：\`${events.file}:${events.line}\``)
  lines.push('')
  lines.push(
    ...table(
      ['事件名', '源码行'],
      events.literals.map((literal) => [
        `\`${literal.value}\``,
        `${literal.line}`
      ])
    )
  )
  lines.push('')
  return lines
}

function renderInjectedMembers() {
  const injected = readInjectedStrategyMembers()
  const host = readInterfaceMembers(HOST_API)
  const declared = new Set(host.members.map((member) => member.name))
  const lines = [heading(3, '注入对象交叉校验'), '']
  lines.push(
    ...paragraph(
      '`agenticStrategy` 由 `src/preload/strategy-bootstrap.ts` 的模板字符串注入，' +
        '与 `StrategyHostApi` 的成员必须完全一致。'
    )
  )
  lines.push(
    ...table(
      ['注入成员', '接口已声明'],
      injected.map((member) => [
        `\`${member.name}\``,
        declared.has(member.name) ? '是' : '否'
      ])
    )
  )
  lines.push('')
  return lines
}

export function buildApiReference() {
  const generatedSections = new Set()
  const lines = [
    heading(1, 'AgenticBrowser API 参考'),
    '',
    originMarker('generated'),
    '',
    '生成命令：`npm run docs:api`',
    '',
    '真源文件：',
    '',
    ...resolveTypeSources(),
    '',
    `生成器使用的 TypeScript 版本：${getTypeScriptVersion()}`,
    '',
    heading(2, '渲染进程桥 `window.agenticBrowser`'),
    '',
    ...renderApiSection(
      SHELL_API,
      '`BrowserShellApi` 全部方法',
      '通过 `contextBridge.exposeInMainWorld` 暴露到渲染进程主 world，' +
        '在 renderer DevTools Console 中可直接调用。',
      generatedSections
    ),
    heading(2, 'Strategy 宿主对象 `agenticStrategy`'),
    '',
    ...renderApiSection(
      HOST_API,
      '`StrategyHostApi` 全部成员',
      '仅在 Strategy 脚本运行的页面隔离 world 中可用，' +
        '与渲染进程主 world 不是同一上下文。',
      generatedSections
    ),
    heading(2, '事件、权限与限额'),
    '',
    ...renderEvents(),
    ...renderEnumSection(),
    ...renderWorkflowNodeKinds(),
    ...renderPermissionMatrix(),
    ...renderLimits(),
    ...renderErrors(),
    ...renderCoverageStats(),
    ...renderInjectedMembers()
  ]
  return composeDocument(lines)
}

export function writeApiReference(dryRun = false) {
  const target = path.join(SKILL_ROOT, OUTPUT_RELATIVE_PATH)
  const content = buildApiReference()
  if (!dryRun) {
    writeFileSync(target, content, 'utf8')
  }
  return { target, content }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes('--dry-run')
  const { target, content } = writeApiReference(dryRun)
  if (dryRun) {
    process.stdout.write(content)
  } else {
    process.stdout.write(`已生成 ${path.relative(REPO_ROOT, target)}\n`)
  }
}
