import type { StrategyBootstrapRequest } from '../shared/contracts'

// 策略网络桥接的安全边界：请求头白名单、响应大小上限、重定向判定。
// 这些规则此前埋在 browser-supervisor 的私有函数里，只能靠真实窗口
// 与真实网络触发，等于没有测试。抽出来后可以逐条验证边界。

export const STRATEGY_MAX_RESPONSE_BYTES = 1024 * 1024

// 只放行内容协商与缓存相关字段。授权、Cookie、Host 等一旦被页面脚本
// 覆盖，等于把用户身份交给策略代码，因此必须在源头拦截而不是依赖
// 下游检查。
const FORBIDDEN_HEADER_PREFIXES =
  /^(?:authorization|cookie|host|origin|referer|proxy-|sec-)/i
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/
const HEADER_VALUE_INJECTION = /[\r\n]/

// 响应回传给策略时同样收窄，避免把 Set-Cookie 之类的凭据泄露给
// 不受信任的策略脚本。
const ALLOWED_RESPONSE_HEADERS = new Set([
  'cache-control',
  'content-language',
  'content-length',
  'content-type',
  'etag',
  'last-modified'
])

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

const MAX_BOOTSTRAP_HREF_LENGTH = 8_192

export function parseStrategyBootstrapRequest(
  value: unknown
): StrategyBootstrapRequest | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('href' in value) ||
    !('isMainFrame' in value) ||
    typeof value.href !== 'string' ||
    value.href.length > MAX_BOOTSTRAP_HREF_LENGTH ||
    typeof value.isMainFrame !== 'boolean'
  ) {
    return null
  }
  return {
    href: value.href,
    isMainFrame: value.isMainFrame
  }
}

export function sanitizeStrategyRequestHeaders(
  value: Record<string, string>
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, headerValue] of Object.entries(value)) {
    const normalized = name.toLowerCase()
    if (
      !HEADER_NAME_PATTERN.test(normalized) ||
      FORBIDDEN_HEADER_PREFIXES.test(normalized) ||
      HEADER_VALUE_INJECTION.test(headerValue)
    ) {
      throw new Error(`Strategy 请求头不允许：${name}`)
    }
    result[normalized] = headerValue
  }
  return result
}

export async function readStrategyResponseBody(
  response: Response,
  maximumBytes: number = STRATEGY_MAX_RESPONSE_BYTES
): Promise<Buffer> {
  if (!response.body) {
    return Buffer.alloc(0)
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) {
        break
      }
      byteLength += next.value.byteLength
      if (byteLength > maximumBytes) {
        await reader.cancel('Strategy 网络响应超过大小限制')
        throw new Error('Strategy 网络响应超过 1 MiB')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(
    chunks.map((chunk) =>
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    ),
    byteLength
  )
}

export function selectStrategyResponseHeaders(
  headers: Headers
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of headers.entries()) {
    const normalized = name.toLowerCase()
    if (ALLOWED_RESPONSE_HEADERS.has(normalized)) {
      result[normalized] = value
    }
  }
  return result
}

export function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUSES.has(status)
}
