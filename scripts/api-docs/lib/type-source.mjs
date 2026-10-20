// 手动维护：TypeScript 类型真源读取层
//
// 本模块只负责「从源码取事实」，不做任何 Markdown 渲染。
// 生成器与校验器共用同一份事实，保证两侧判断口径一致。

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require('typescript')

// 脚本位于 <repo>/scripts/api-docs/lib，向上三级回到仓库根。
export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..'
)

// 待发布与待校验的 Skill 目录。它与脚本分离，是为了让发布出去的内容只有文档。
export const SKILL_RELATIVE_PATH = 'docs/skills/agentic-browser-api'

export const SKILL_ROOT = path.join(REPO_ROOT, SKILL_RELATIVE_PATH)

export const SOURCE_FILES = {
  contracts: 'src/shared/contracts.ts',
  preloadIndex: 'src/preload/index.ts',
  strategyBootstrap: 'src/preload/strategy-bootstrap.ts',
  strategyRuntime: 'src/main/strategy-runtime.ts'
}

function absolute(relativePath) {
  return path.join(REPO_ROOT, relativePath)
}

let cachedSources = null

function getSource(relativePath) {
  if (!cachedSources) {
    cachedSources = new Map()
  }
  if (!cachedSources.has(relativePath)) {
    const absolutePath = absolute(relativePath)
    const text = readFileSync(absolutePath, 'utf8')
    cachedSources.set(
      relativePath,
      ts.createSourceFile(
        absolutePath,
        text,
        ts.ScriptTarget.ES2023,
        true,
        ts.ScriptKind.TS
      )
    )
  }
  return cachedSources.get(relativePath)
}

/**
 * 解析失败一律抛错并给出文件与行号，绝不静默跳过。
 */
export function fail(message, relativePath, node) {
  const location = node
    ? ` [${relativePath}:${lineOf(relativePath, node)}]`
    : relativePath
      ? ` [${relativePath}]`
      : ''
  throw new Error(`APIDOC_PARSE_ERROR${location}: ${message}`)
}

export function lineOf(relativePath, node) {
  const source = getSource(relativePath)
  const start = node.getStart(source)
  return source.getLineAndCharacterOfPosition(start).line + 1
}

function symbolName(node) {
  if (node.name && ts.isIdentifier(node.name)) {
    return node.name.text
  }
  // VariableStatement 的名字挂在 declarationList 上
  if (ts.isVariableStatement(node)) {
    const declarations = node.declarationList.declarations
    if (declarations.length === 1 && ts.isIdentifier(declarations[0].name)) {
      return declarations[0].name.text
    }
  }
  return null
}

/**
 * 取顶层具名声明（interface / type / const），返回 node 与所在文件。
 */
function findTopLevel(relativePath, name, predicate) {
  const source = getSource(relativePath)
  let found = null
  source.forEachChild((node) => {
    if (found) {
      return
    }
    if (symbolName(node) === name && predicate(node)) {
      found = node
    }
  })
  if (!found) {
    fail(`未找到顶层声明 ${name}`, relativePath)
  }
  return found
}

export function getInterfaceDeclaration(
  name,
  relativePath = SOURCE_FILES.contracts
) {
  return findTopLevel(relativePath, name, ts.isInterfaceDeclaration)
}

export function getTypeAliasDeclaration(
  name,
  relativePath = SOURCE_FILES.contracts
) {
  return findTopLevel(relativePath, name, ts.isTypeAliasDeclaration)
}

export function getVariableDeclaration(
  name,
  relativePath = SOURCE_FILES.contracts
) {
  const source = getSource(relativePath)
  let statement = null
  source.forEachChild((node) => {
    if (statement || !ts.isVariableStatement(node)) {
      return
    }
    const matches = node.declarationList.declarations.some(
      (entry) => ts.isIdentifier(entry.name) && entry.name.text === name
    )
    if (matches) {
      statement = node
    }
  })
  if (!statement) {
    fail(`未找到顶层声明 ${name}`, relativePath)
  }
  const declaration = statement.declarationList.declarations.find(
    (entry) => ts.isIdentifier(entry.name) && entry.name.text === name
  )
  if (!declaration) {
    fail(`变量声明 ${name} 缺少初始化器`, relativePath)
  }
  return { statement, declaration }
}

function typeToString(node, relativePath) {
  if (!node) {
    fail('缺少类型节点', relativePath)
  }
  const source = getSource(relativePath)
  return node.getText(source)
}

/**
 * 读取 interface 的成员，保持源码声明顺序。
 */
export function readInterfaceMembers(
  name,
  relativePath = SOURCE_FILES.contracts
) {
  const declaration = getInterfaceDeclaration(name, relativePath)
  const members = []
  for (const member of declaration.members) {
    members.push(readCallableMember(member, relativePath))
  }
  return {
    name,
    file: relativePath,
    line: lineOf(relativePath, declaration),
    members
  }
}

function readCallableMember(member, relativePath) {
  if (ts.isPropertySignature(member) || ts.isMethodSignature(member)) {
    const memberName =
      member.name && ts.isIdentifier(member.name) ? member.name.text : null
    if (!memberName) {
      fail('不支持计算属性名或字符串字面量成员名', relativePath, member)
    }
    const optional = Boolean(member.questionToken)
    const readonly = Boolean(
      ts
        .getModifiers(member)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)
    )
    const parameters = member.parameters
      ? member.parameters.map((parameter) =>
          readParameter(parameter, relativePath)
        )
      : []
    const returnType = typeToString(member.type, relativePath)
    return {
      name: memberName,
      kind:
        parameters.length > 0 || ts.isMethodSignature(member)
          ? 'method'
          : 'property',
      optional,
      readonly,
      parameters,
      returnType,
      line: lineOf(relativePath, member)
    }
  }
  fail('interface 中存在不支持的成员形式', relativePath, member)
}

function readParameter(parameter, relativePath) {
  if (!ts.isIdentifier(parameter.name)) {
    fail('不支持解构或重命名参数', relativePath, parameter)
  }
  const dotDotDot = Boolean(parameter.dotDotDotToken)
  return {
    name: `${dotDotDot ? '...' : ''}${parameter.name.text}`,
    type: typeToString(parameter.type, relativePath),
    optional:
      Boolean(parameter.questionToken) || Boolean(parameter.initializer),
    line: lineOf(relativePath, parameter)
  }
}

/**
 * 读取联合类型的字面量成员，保持源码顺序。
 */
export function readUnionLiterals(name, relativePath = SOURCE_FILES.contracts) {
  const declaration = getTypeAliasDeclaration(name, relativePath)
  const literals = []
  collectUnionLiterals(declaration.type, literals, relativePath)
  if (literals.length === 0) {
    fail(`联合类型 ${name} 未包含字面量成员`, relativePath, declaration)
  }
  return {
    name,
    file: relativePath,
    line: lineOf(relativePath, declaration),
    literals
  }
}

function collectUnionLiterals(node, output, relativePath) {
  if (ts.isUnionTypeNode(node)) {
    node.types.forEach((child) =>
      collectUnionLiterals(child, output, relativePath)
    )
    return
  }
  if (ts.isLiteralTypeNode(node)) {
    const literal = node.literal
    if (
      ts.isStringLiteral(literal) ||
      ts.isNumericLiteral(literal) ||
      literal.kind === ts.SyntaxKind.TrueKeyword ||
      literal.kind === ts.SyntaxKind.FalseKeyword
    ) {
      output.push({
        value: literal.getText(getSource(relativePath)),
        line: lineOf(relativePath, node)
      })
      return
    }
  }
  fail('联合类型包含非字面量成员，无法生成枚举表', relativePath, node)
}

function unwrapObjectLiteral(initializer, name, relativePath, node) {
  let current = initializer
  if (current && ts.isAsExpression(current)) {
    current = current.expression
  }
  if (current && ts.isParenthesizedExpression(current)) {
    current = current.expression
  }
  if (!current || !ts.isObjectLiteralExpression(current)) {
    fail(`常量 ${name} 不是对象字面量`, relativePath, node ?? initializer)
  }
  return current
}

/**
 * 读取对象字面量常量的全部键名，用于统计 IPC 通道数量。
 */
export function readConstObjectKeys(
  name,
  relativePath = SOURCE_FILES.contracts
) {
  const { declaration } = getVariableDeclaration(name, relativePath)
  const literal = unwrapObjectLiteral(
    declaration.initializer,
    name,
    relativePath,
    declaration
  )
  const keys = []
  for (const property of literal.properties) {
    if (!ts.isPropertyAssignment(property)) {
      fail('对象字面量包含不支持的非赋值成员', relativePath, property)
    }
    const keyName = ts.isIdentifier(property.name)
      ? property.name.text
      : ts.isStringLiteral(property.name)
        ? property.name.text
        : null
    if (!keyName) {
      fail('对象字面量包含计算属性名', relativePath, property)
    }
    keys.push({ name: keyName, line: lineOf(relativePath, property) })
  }
  return { name, file: relativePath, keys }
}

/**
 * 读取 `as const` 对象中某个键的字面量值。
 */
export function readConstObjectValue(
  name,
  key,
  relativePath = SOURCE_FILES.contracts
) {
  const { declaration } = getVariableDeclaration(name, relativePath)
  const literal = unwrapObjectLiteral(
    declaration.initializer,
    name,
    relativePath,
    declaration
  )
  for (const property of literal.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === key
    ) {
      if (!ts.isStringLiteral(property.initializer)) {
        fail(`常量 ${name}.${key} 不是字符串字面量`, relativePath, property)
      }
      return property.initializer.text
    }
  }
  fail(`常量 ${name} 缺少键 ${key}`, relativePath, declaration)
}

/**
 * 读取数值常量（用于限额说明），支持 `128 * 1024` 这类二元表达式折叠。
 */
export function readNumericConstant(name, relativePath) {
  const file = relativePath ?? SOURCE_FILES.strategyRuntime
  const { declaration } = getVariableDeclaration(name, file)
  const value = foldNumeric(declaration.initializer, file)
  return {
    name,
    file,
    line: lineOf(file, declaration),
    value
  }
}

function foldNumeric(node, relativePath) {
  if (!node) {
    fail('数值常量缺少初始化器', relativePath, node)
  }
  if (ts.isNumericLiteral(node)) {
    return Number(node.text)
  }
  if (ts.isParenthesizedExpression(node)) {
    return foldNumeric(node.expression, relativePath)
  }
  if (ts.isBinaryExpression(node)) {
    const left = foldNumeric(node.left, relativePath)
    const right = foldNumeric(node.right, relativePath)
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.AsteriskToken:
        return left * right
      case ts.SyntaxKind.PlusToken:
        return left + right
      case ts.SyntaxKind.MinusToken:
        return left - right
      case ts.SyntaxKind.SlashToken:
        return left / right
      default:
        fail('数值常量包含不支持的运算符', relativePath, node)
    }
  }
  fail('数值常量包含无法折叠的表达式', relativePath, node)
}

/**
 * 判断某个 interface 成员的返回类型是否为项目内 interface，
 * 并返回该 interface 名称，供字段表展开使用。
 */
export function referencedInterfaceName(
  member,
  relativePath = SOURCE_FILES.contracts
) {
  const source = getSource(relativePath)
  const typeNode = member.returnTypeNode
  if (!typeNode || !ts.isTypeReferenceNode(typeNode)) {
    return null
  }
  const typeName = typeNode.typeName.getText(source)
  return typeName
}

/**
 * 在源码文本中提取显式抛出的错误文案字面量，附带行号。
 * 只收集 `throw new Error('...')` 形式，模板字符串按原文保留。
 */
export function readThrownErrorMessages(relativePath) {
  const source = getSource(relativePath)
  const messages = []
  const visit = (node) => {
    if (
      ts.isNewExpression(node) &&
      node.expression.getText(source) === 'Error' &&
      node.arguments &&
      node.arguments.length > 0
    ) {
      const [first] = node.arguments
      if (
        ts.isStringLiteral(first) ||
        ts.isNoSubstitutionTemplateLiteral(first)
      ) {
        messages.push({
          text: first.text,
          line: lineOf(relativePath, node),
          file: relativePath
        })
      } else if (ts.isTemplateExpression(first)) {
        messages.push({
          text: first.getText(source),
          line: lineOf(relativePath, node),
          file: relativePath
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return messages
}

/**
 * 读取 `invoke(...)` 的 switch 分支里出现的方法名，用于交叉校验。
 * 只收集 `case '<method>':` 后紧跟 `this.requirePermission(...)` 的分支，
 * 避免把 signal 的 installed/started 等类型误判为宿主方法。
 */
export function readInvokedHostMethods(
  relativePath = SOURCE_FILES.strategyRuntime
) {
  const source = getSource(relativePath)
  const methods = new Set()
  const visit = (node) => {
    if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression)) {
      const hasPermissionGuard = node.statements.some((statement) =>
        statement.getText(source).includes('this.requirePermission')
      )
      if (hasPermissionGuard) {
        methods.add(node.expression.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return [...methods]
}

/**
 * 读取模板字符串中注入的 agenticStrategy 成员名。
 *
 * 注入代码是 `buildStrategySource` 返回的模板字符串文本，不是 AST 节点，
 * 因此这里按文本结构解析：先定位 `const agenticStrategy = Object.freeze({`，
 * 再按缩进匹配同一层的 `name:` 键，遇到 `})` 结束。
 */
export function readInjectedStrategyMembers(
  relativePath = SOURCE_FILES.strategyBootstrap
) {
  const source = getSource(relativePath)
  const text = source.getFullText()
  const anchor = text.indexOf('const agenticStrategy = Object.freeze({')
  if (anchor < 0) {
    fail(
      '未在 strategy-bootstrap.ts 中找到 agenticStrategy 注入对象',
      relativePath
    )
  }
  const bodyStart = anchor + 'const agenticStrategy = Object.freeze({'.length
  const bodyEnd = text.indexOf('\n  })', bodyStart)
  if (bodyEnd < 0) {
    fail('未找到 agenticStrategy 注入对象的结束位置', relativePath)
  }
  const body = text.slice(bodyStart, bodyEnd)
  const members = []
  for (const rawLine of body.split('\n')) {
    const match = /^ {4}([A-Za-z_$][\w$]*):/.exec(rawLine)
    if (match) {
      members.push({ name: match[1] })
    }
  }
  if (members.length === 0) {
    fail('agenticStrategy 注入对象未解析出任何成员', relativePath)
  }
  return members
}

/**
 * 从可辨识联合（如 WorkflowNode）中提取 kind 字段的字面量取值。
 * 源码中该类联合由多段交叉类型组成，kind 为其中的字符串字面量属性。
 */
export function readDiscriminatedUnionKinds(
  name,
  relativePath = SOURCE_FILES.contracts
) {
  const declaration = getTypeAliasDeclaration(name, relativePath)
  const kinds = []
  const collect = (node) => {
    if (ts.isUnionTypeNode(node)) {
      node.types.forEach(collect)
      return
    }
    if (ts.isIntersectionTypeNode(node)) {
      node.types.forEach(collect)
      return
    }
    if (ts.isParenthesizedTypeNode(node)) {
      collect(node.type)
      return
    }
    if (ts.isTypeLiteralNode(node) || ts.isIntersectionTypeNode(node)) {
      for (const member of node.members ?? []) {
        if (
          ts.isPropertySignature(member) &&
          ts.isIdentifier(member.name) &&
          member.name.text === 'kind' &&
          member.type &&
          ts.isLiteralTypeNode(member.type) &&
          ts.isStringLiteral(member.type.literal)
        ) {
          kinds.push({
            value: member.type.literal.text,
            line: lineOf(relativePath, member)
          })
        }
      }
    }
  }
  collect(declaration.type)
  if (kinds.length === 0) {
    fail(`可辨识联合 ${name} 未解析出 kind 取值`, relativePath, declaration)
  }
  return {
    name,
    file: relativePath,
    line: lineOf(relativePath, declaration),
    kinds
  }
}

export function getTypeScriptVersion() {
  return ts.version
}

export { ts }
