// 手动维护：Markdown 输出器
//
// 不依赖 prettier，自行控制换行、缩进与 80 列行长上限，
// 保证同一输入重复生成结果逐字节一致。

export const MAX_LINE_WIDTH = 80

const FRONTMATTER_FENCE = '---'

/**
 * 把长散文按显示宽度折行，返回多行数组。
 * 以反引号标识符整体与空格作为断点，避免折断标识符。
 */
export function wrapParagraph(text, width = MAX_LINE_WIDTH) {
  if (displayWidth(text) <= width) {
    return [text]
  }
  const tokens = text.match(/`[^`]*`|\s+|[^\s`]+/gu) ?? [text]
  const lines = []
  let current = ''
  for (const token of tokens) {
    if (
      current.length > 0 &&
      displayWidth(current + token) > width &&
      token.trim().length > 0
    ) {
      lines.push(current.trimEnd())
      current = token.trimStart()
      continue
    }
    current += token
  }
  if (current.trim().length > 0) {
    lines.push(current.trimEnd())
  }
  return lines
}

/**
 * 组装文档：统一保证文件末尾只有一个换行、无行尾空格。
 */
export function composeDocument(lines) {
  const normalized = lines.map((line) => line.replace(/[ \t]+$/u, ''))
  while (normalized.length > 0 && normalized[normalized.length - 1] === '') {
    normalized.pop()
  }
  return `${normalized.join('\n')}\n`
}

export function frontmatter(fields) {
  const lines = [FRONTMATTER_FENCE]
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: >-`)
    for (const line of wrapParagraph(value, MAX_LINE_WIDTH - 2)) {
      lines.push(`  ${line}`)
    }
  }
  lines.push(FRONTMATTER_FENCE)
  lines.push('')
  return lines
}

export function heading(level, text) {
  return `${'#'.repeat(level)} ${text}`
}

/**
 * 生成「自动生成 / 人工维护」标记行。
 */
export function originMarker(origin) {
  return origin === 'generated'
    ? '> 本文件由脚本自动生成，请勿手工编辑。'
    : '> 本文件为人工维护内容。'
}

/**
 * 代码围栏，语言可为空。
 */
export function codeBlock(language, content) {
  const fence = '```'
  return [`${fence}${language}`, ...content.split('\n'), fence]
}

/**
 * 统计字符串的显示宽度（中文按 2 计），供行长检查与表格对齐使用。
 */
export function displayWidth(text) {
  let width = 0
  for (const char of text) {
    width += /[\u3000-\u9fff\uff00-\uffef]/u.test(char) ? 2 : 1
  }
  return width
}

/**
 * 生成 Markdown 表格，按显示宽度对齐（中文占两列）。
 * 若对齐后总宽超出限制，则降级为「列表 + 行内代码」形式，
 * 因为强行折行会破坏 Markdown 表格结构。
 */
export function table(headers, rows, maxWidth = MAX_LINE_WIDTH) {
  const escape = (value) => String(value).replace(/\|/gu, '\\|')
  const widths = headers.map((header, index) => {
    const cells = rows.map((row) => displayWidth(escape(row[index] ?? '')))
    return Math.max(displayWidth(header), ...cells, 3)
  })
  const totalWidth =
    widths.reduce((sum, width) => sum + width, 0) + 3 * (headers.length - 1) + 4
  if (totalWidth > maxWidth) {
    return renderAsList(headers, rows)
  }
  const pad = (value, width) => {
    const padding = width - displayWidth(value)
    return `${value}${' '.repeat(padding > 0 ? padding : 0)}`
  }
  const renderRow = (cells) =>
    `| ${cells
      .map((cell, index) => pad(escape(cell ?? ''), widths[index]))
      .join(' | ')} |`
  const separator = `| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`
  return [renderRow(headers), separator, ...rows.map(renderRow)]
}

/**
 * 表格降级形态：每条记录一个列表项，字段以「字段名：值」呈现。
 * 列表项本身按剩余宽度折行，续行对齐到内容缩进。
 */
function renderAsList(headers, rows, maxWidth = MAX_LINE_WIDTH) {
  const lines = []
  for (const row of rows) {
    const parts = headers
      .map((header, index) => {
        const value = String(row[index] ?? '')
        return `${header} ${value}`.trim()
      })
      .filter((part) => part.length > 0)
    const text = `- ${parts.join('，')}`
    const wrapped = wrapParagraph(text, maxWidth)
    lines.push(...wrapped)
  }
  return lines
}
