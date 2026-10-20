// 手动维护：防漂移校验器
//
// 校验分五类，任一失败即以非零码退出：
// 1. 生成物一致性：重新生成并与已提交文件逐字节比对。
// 2. 标识符真实性：文档中反引号包裹的标识符必须存在于类型真源。
// 3. 交叉一致性：方法数、注入成员、权限子集等交叉关系成立。
// 4. 常量一致：文档记录的限额数值等于源码常量。
// 5. Markdown 结构：标题层级、相对链接、围栏闭合、行尾空格、末尾换行。
//
// 全程只读，不写任何文件，不访问网络。

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

import {
  REPO_ROOT,
  SKILL_ROOT,
  SOURCE_FILES,
  readConstObjectKeys,
  readInjectedStrategyMembers,
  readInterfaceMembers,
  readInvokedHostMethods,
  readNumericConstant,
  readUnionLiterals
} from './lib/type-source.mjs'
import {
  buildIdentifierUniverse,
  extractTypeNames
} from './lib/identifier-universe.mjs'
import { MAX_LINE_WIDTH, displayWidth } from './lib/markdown.mjs'
import {
  buildApiReference,
  OUTPUT_RELATIVE_PATH
} from './generate-api-reference.mjs'

const problems = []
const stats = {
  methods: 0,
  events: 0,
  types: 0,
  files: 0,
  identifiers: 0,
  links: 0
}

function report(title, type, location, detail) {
  problems.push({ title, type, location, detail })
}

/**
 * 收集 Skill 目录下全部 Markdown 文件（相对路径）。
 */
function collectMarkdownFiles() {
  const results = []
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = path.join(directory, name)
      const stat = statSync(absolute)
      if (stat.isDirectory()) {
        walk(absolute)
      } else if (name.endsWith('.md')) {
        results.push(absolute)
      }
    }
  }
  walk(SKILL_ROOT)
  return results
}

function relativeToSkill(absolute) {
  return path.relative(SKILL_ROOT, absolute).split(path.sep).join('/')
}

/**
 * 校验 1：生成物与重新生成结果逐字节一致。
 */
function checkGeneratedArtifacts() {
  const target = path.join(SKILL_ROOT, OUTPUT_RELATIVE_PATH)
  const expected = buildApiReference()
  let actual
  try {
    actual = readFileSync(target, 'utf8')
  } catch {
    report(
      '生成物缺失',
      'generated-missing',
      `${OUTPUT_RELATIVE_PATH}`,
      '未找到生成文件，请执行 npm run docs:api'
    )
    return
  }
  if (actual === expected) {
    return
  }
  const actualLines = actual.split('\n')
  const expectedLines = expected.split('\n')
  const limit = Math.max(actualLines.length, expectedLines.length)
  for (let index = 0; index < limit; index += 1) {
    const left = actualLines[index]
    const right = expectedLines[index]
    if (left !== right) {
      report(
        '生成物与类型真源不一致',
        'generated-drift',
        `${OUTPUT_RELATIVE_PATH}:${index + 1}`,
        `期望 ${JSON.stringify(right ?? '<文件结束>')}，实际 ${JSON.stringify(
          left ?? '<文件结束>'
        )}，请执行 npm run docs:api`
      )
      return
    }
  }
}

/**
 * 从 Markdown 中提取反引号包裹的标识符。
 * 支持单反引号与双反引号两种包裹形式。
 */
function extractInlineCode(text) {
  const results = []
  // 先匹配双反引号，避免被单反引号规则截断。
  const doublePattern = /``([^`]+)``/gu
  let match
  while ((match = doublePattern.exec(text)) !== null) {
    results.push(match[1])
  }
  const stripped = text.replace(doublePattern, ' ')
  const singlePattern = /`([^`\n]+)`/gu
  while ((match = singlePattern.exec(stripped)) !== null) {
    results.push(match[1])
  }
  return results
}

/**
 * 判断候选标识符是否「形如」API 名称。
 * 只对这类候选做真实性校验，避免误报普通代码片段。
 */
function looksLikeIdentifier(candidate) {
  return (
    /^[A-Za-z_$][\w$]*$/u.test(candidate) ||
    /^[a-z][a-z0-9-]*$/u.test(candidate) ||
    /^[a-z][\w-]*\.[\w.-]+$/u.test(candidate)
  )
}

/**
 * 判断是否为明显属于环境、语法、命令或文件名的词，无需做标识符校验。
 * 这些词不是本项目的 API，无法从类型真源推导。
 */
function isIgnorable(candidate) {
  const ignored = new Set([
    // 语言与工具
    'ts',
    'js',
    'mjs',
    'json',
    'npm',
    'node',
    'typescript',
    'javascript',
    'markdown',
    'prettier',
    'eslint',
    'vitest',
    'electron',
    'require',
    'import',
    'engines',
    'path',
    'fs',
    'child_process',
    // 基础值
    'true',
    'false',
    'null',
    'undefined',
    'string',
    'number',
    'boolean',
    'object',
    // 示例代码中的局部变量与参数名
    'message',
    'data',
    'payload',
    'options',
    'listener',
    'draft',
    'snapshot',
    'tabs',
    'workspace',
    'projectId',
    'profileId',
    'strategies',
    'strategy',
    'allowed',
    'off',
    'visible',
    'result',
    'profiles',
    // 领域通用词
    'allowlist',
    'idle',
    'timeouts',
    'kind'
  ])
  return ignored.has(candidate)
}

/**
 * 校验 2：文档中出现的标识符必须真实存在于类型真源。
 */
function checkIdentifiers(files) {
  const universe = buildIdentifierUniverse()
  const known = new Set([
    ...universe.methods,
    ...universe.types,
    ...universe.events,
    ...universe.enumMembers,
    ...universe.fields,
    ...universe.hostNames
  ])
  stats.methods = universe.methods.size
  stats.events = universe.events.size
  stats.types = universe.types.size

  for (const file of files) {
    const relative = relativeToSkill(file)
    const lines = readFileSync(file, 'utf8').split('\n')
    let inFence = false
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (/^\s*```/u.test(line)) {
        inFence = !inFence
        continue
      }
      if (inFence) {
        // 代码块内的调用单独校验，见 checkCodeFences。
        continue
      }
      for (const candidate of extractInlineCode(line)) {
        const trimmed = candidate.trim()
        if (trimmed.length === 0) {
          continue
        }
        stats.identifiers += 1
        if (isIgnorable(trimmed)) {
          continue
        }
        // 排除文件路径、URL、命令、带空格或参数列表的片段。
        if (
          trimmed.includes('/') ||
          trimmed.includes(' ') ||
          trimmed.includes('(') ||
          trimmed.includes(')') ||
          trimmed.includes(':') ||
          trimmed.includes('=') ||
          /\.(md|ts|mjs|js|json|css|html)$/u.test(trimmed) ||
          trimmed.startsWith('npm ') ||
          trimmed.startsWith('node ')
        ) {
          continue
        }
        if (!looksLikeIdentifier(trimmed)) {
          continue
        }
        if (!known.has(trimmed)) {
          report(
            '文档引用了类型真源中不存在的标识符',
            'unknown-identifier',
            `${relative}:${index + 1}`,
            `\`${trimmed}\` 未在类型真源中找到`
          )
        }
      }
    }
  }
}

/**
 * 校验 2 的补充：代码块中对 window.agenticBrowser 的方法调用必须真实存在。
 */
function checkCodeFences(files) {
  const shell = readInterfaceMembers('BrowserShellApi')
  const methodNames = new Set(shell.members.map((member) => member.name))
  for (const file of files) {
    const relative = relativeToSkill(file)
    const lines = readFileSync(file, 'utf8').split('\n')
    let inFence = false
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (/^\s*```/u.test(line)) {
        inFence = !inFence
        continue
      }
      if (!inFence) {
        continue
      }
      const callPattern = /window\.agenticBrowser\.([A-Za-z_$][\w$]*)/gu
      let match
      while ((match = callPattern.exec(line)) !== null) {
        const method = match[1]
        if (!methodNames.has(method)) {
          report(
            '示例代码调用了不存在的方法',
            'unknown-method-call',
            `${relative}:${index + 1}`,
            `window.agenticBrowser.${method} 不在 BrowserShellApi 中`
          )
        }
      }
      const strategyPattern = /agenticStrategy\.([A-Za-z_$][\w$]*)/gu
      const host = new Set(
        readInterfaceMembers('StrategyHostApi').members.map(
          (member) => member.name
        )
      )
      while ((match = strategyPattern.exec(line)) !== null) {
        const member = match[1]
        if (!host.has(member)) {
          report(
            '示例代码调用了不存在的宿主成员',
            'unknown-host-call',
            `${relative}:${index + 1}`,
            `agenticStrategy.${member} 不在 StrategyHostApi 中`
          )
        }
      }
    }
  }
}

/**
 * 校验 3：交叉一致性。
 */
function checkCrossConsistency() {
  const shell = readInterfaceMembers('BrowserShellApi')
  const channels = readConstObjectKeys('IPC_CHANNELS')
  if (shell.members.length !== channels.keys.length) {
    report(
      '渲染进程桥方法数与 IPC 通道数不相等',
      'cross-consistency',
      SOURCE_FILES.contracts,
      `${shell.members.length} 个方法对 ${channels.keys.length} 个通道`
    )
  }

  const host = readInterfaceMembers('StrategyHostApi')
  const declared = new Set(host.members.map((member) => member.name))
  for (const injected of readInjectedStrategyMembers()) {
    if (!declared.has(injected.name)) {
      report(
        '注入成员未在接口中声明',
        'cross-consistency',
        SOURCE_FILES.strategyBootstrap,
        `agenticStrategy.${injected.name} 缺少类型声明`
      )
    }
  }
  const injectedNames = new Set(
    readInjectedStrategyMembers().map((member) => member.name)
  )
  for (const member of host.members) {
    if (!injectedNames.has(member.name)) {
      report(
        '接口成员未在注入对象中实现',
        'cross-consistency',
        SOURCE_FILES.contracts,
        `StrategyHostApi.${member.name} 在注入对象中缺失`
      )
    }
  }

  const hostMethods = new Set(
    readUnionLiterals('StrategyHostMethod').literals.map((literal) =>
      literal.value.replace(/^['"]|['"]$/gu, '')
    )
  )
  for (const method of readInvokedHostMethods()) {
    if (!hostMethods.has(method)) {
      report(
        '底层调用方法未纳入 StrategyHostMethod',
        'cross-consistency',
        SOURCE_FILES.strategyRuntime,
        `${method} 不在 StrategyHostMethod 联合类型中`
      )
    }
  }

  // IPC_CHANNELS 的每个通道值应唯一。
  const channelValues = new Set()
  for (const key of channels.keys) {
    if (channelValues.has(key.name)) {
      report(
        'IPC 通道键重复',
        'cross-consistency',
        SOURCE_FILES.contracts,
        `${key.name} 重复声明`
      )
    }
    channelValues.add(key.name)
  }
}

/**
 * 校验 4：文档记录的限额数值等于源码常量。
 */
function checkLimits(files) {
  const limitConstants = [
    { name: 'INSTALL_TIMEOUT_MS', file: SOURCE_FILES.strategyRuntime },
    { name: 'MAX_HOST_PAYLOAD_BYTES', file: SOURCE_FILES.strategyRuntime },
    { name: 'MAX_LOG_MESSAGE_LENGTH', file: SOURCE_FILES.strategyRuntime },
    { name: 'FIRST_STRATEGY_WORLD_ID', file: SOURCE_FILES.strategyRuntime }
  ]
  const reference = readFileSync(
    path.join(SKILL_ROOT, OUTPUT_RELATIVE_PATH),
    'utf8'
  )
  for (const entry of limitConstants) {
    const constant = readNumericConstant(entry.name, entry.file)
    const needle = `\`${constant.name}\``
    const line = reference
      .split('\n')
      .find((row) => row.trim().startsWith('|') && row.includes(needle))
    if (!line) {
      report(
        '文档缺少限额常量记录',
        'limit-missing',
        OUTPUT_RELATIVE_PATH,
        `${constant.name} 未在限额表格中找到`
      )
      continue
    }
    const cells = line
      .split('|')
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0)
    const valueCell = cells[1]
    if (valueCell !== String(constant.value)) {
      report(
        '文档中的限额数值与源码常量不一致',
        'limit-mismatch',
        OUTPUT_RELATIVE_PATH,
        `${constant.name} 期望 ${constant.value}，文档为 ${valueCell}`
      )
    }
  }
  void files
}

/**
 * 校验 5：Markdown 结构。
 */
function checkMarkdownStructure(files) {
  for (const file of files) {
    const relative = relativeToSkill(file)
    const raw = readFileSync(file, 'utf8')
    const lines = raw.split('\n')

    // 末尾单个换行
    if (!raw.endsWith('\n')) {
      report(
        '文件末尾缺少换行',
        'md-trailing-newline',
        relative,
        '末尾应保留单个换行'
      )
    }
    if (raw.endsWith('\n\n')) {
      report(
        '文件末尾存在多余空行',
        'md-trailing-newline',
        relative,
        '末尾应只保留单个换行'
      )
    }

    // 行尾空格
    let fenceOpen = false
    let fenceStartLine = 0
    let previousHeadingLevel = 0
    let inFrontmatter = false
    let frontmatterDone = false
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      const lineNumber = index + 1

      if (index === 0 && line.trim() === '---') {
        inFrontmatter = true
        continue
      }
      if (inFrontmatter) {
        if (line.trim() === '---') {
          inFrontmatter = false
          frontmatterDone = true
        }
        continue
      }
      void frontmatterDone

      if (/[ \t]+$/u.test(line)) {
        report(
          '行尾存在多余空格',
          'md-trailing-space',
          `${relative}:${lineNumber}`,
          JSON.stringify(line.slice(-10))
        )
      }

      if (/^\s*```/u.test(line)) {
        if (!fenceOpen) {
          fenceOpen = true
          fenceStartLine = lineNumber
        } else {
          fenceOpen = false
        }
        continue
      }

      if (fenceOpen) {
        continue
      }

      const headingMatch = /^(#{1,6})\s+/u.exec(line)
      if (headingMatch) {
        const level = headingMatch[1].length
        if (previousHeadingLevel > 0 && level > previousHeadingLevel + 1) {
          report(
            '标题层级跳级',
            'md-heading-skip',
            `${relative}:${lineNumber}`,
            `从 ${previousHeadingLevel} 级跳到 ${level} 级`
          )
        }
        previousHeadingLevel = level
      }

      // 相对链接目标存在性
      const linkPattern = /\[[^\]]*\]\(([^)]+)\)/gu
      let linkMatch
      while ((linkMatch = linkPattern.exec(line)) !== null) {
        const target = linkMatch[1]
        stats.links += 1
        if (
          target.startsWith('http://') ||
          target.startsWith('https://') ||
          target.startsWith('#')
        ) {
          continue
        }
        const cleanTarget = target.split('#')[0]
        if (cleanTarget.length === 0) {
          continue
        }
        const resolved = path.resolve(path.dirname(file), cleanTarget)
        try {
          statSync(resolved)
        } catch {
          report(
            '相对链接目标不存在',
            'md-broken-link',
            `${relative}:${lineNumber}`,
            target
          )
        }
      }
    }

    if (fenceOpen) {
      report(
        '代码围栏未闭合',
        'md-fence-unclosed',
        `${relative}:${fenceStartLine}`,
        '存在未闭合的 ``` 围栏'
      )
    }
  }
}

/**
 * 校验 6：行长上限（仅对非代码块、非表格结构行做提示级检查）。
 * 超宽的代码签名与表格属于不可折行内容，不计入失败。
 */
function checkLineWidth(files) {
  for (const file of files) {
    const relative = relativeToSkill(file)
    const lines = readFileSync(file, 'utf8').split('\n')
    let inFence = false
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (/^\s*```/u.test(line)) {
        inFence = !inFence
        continue
      }
      if (inFence) {
        continue
      }
      if (line.trim().startsWith('|')) {
        continue
      }
      if (displayWidth(line) > MAX_LINE_WIDTH) {
        report(
          '行宽超过限制',
          'md-line-width',
          `${relative}:${index + 1}`,
          `${displayWidth(line)} 列，上限 ${MAX_LINE_WIDTH}`
        )
      }
    }
  }
}

function sortProblems() {
  problems.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type < right.type ? -1 : 1
    }
    if (left.location !== right.location) {
      return left.location < right.location ? -1 : 1
    }
    return left.detail < right.detail ? -1 : 1
  })
}

function main() {
  const files = collectMarkdownFiles()
  stats.files = files.length

  checkGeneratedArtifacts()
  checkIdentifiers(files)
  checkCodeFences(files)
  checkCrossConsistency()
  checkLimits(files)
  checkMarkdownStructure(files)
  checkLineWidth(files)

  sortProblems()

  if (problems.length > 0) {
    process.stderr.write(`API 文档校验失败，共 ${problems.length} 个问题：\n\n`)
    for (const problem of problems) {
      process.stderr.write(
        `- [${problem.type}] ${problem.title}\n` +
          `  位置：${problem.location}\n` +
          `  详情：${problem.detail}\n`
      )
    }
    process.stderr.write('\n生成物相关差异请执行 npm run docs:api 后重试。\n')
    process.exitCode = 1
    return
  }

  process.stdout.write(
    'API 文档校验通过。\n' +
      `  已校验文件：${stats.files}\n` +
      `  方法：${stats.methods}，事件：${stats.events}，类型：${stats.types}\n` +
      `  标识符：${stats.identifiers}，相对链接：${stats.links}\n` +
      `  基线路径：${path.relative(REPO_ROOT, SKILL_ROOT)}\n`
  )
}

void extractTypeNames

main()
