const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

export function normalizeNavigationUrl(input: string): string {
  const trimmed = input.trim()

  if (trimmed.length === 0) {
    throw new Error('URL 不能为空')
  }

  const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)
    ? trimmed
    : `https://${trimmed}`

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new Error('URL 格式无效')
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error(`不允许导航到 ${url.protocol} URL`)
  }

  return url.toString()
}
