import type { StrategyDefinition, StrategyManifest } from '../shared/contracts'

interface ParsedMatchPattern {
  schemes: ReadonlySet<'http:' | 'https:'>
  host: string
  includeSubdomains: boolean
  port: string | null
  pathExpression: RegExp
}

export interface StrategyMatchContext {
  url: string
  isMainFrame: boolean
  allowedStrategyIds: ReadonlySet<string>
}

export function resolveMatchingStrategies(
  definitions: StrategyDefinition[],
  context: StrategyMatchContext
): StrategyDefinition[] {
  return definitions
    .filter(
      (definition) =>
        definition.enabled &&
        context.allowedStrategyIds.has(definition.manifest.id) &&
        strategyMatches(definition.manifest, context.url, context.isMainFrame)
    )
    .sort((left, right) =>
      left.manifest.id < right.manifest.id
        ? -1
        : left.manifest.id > right.manifest.id
          ? 1
          : 0
    )
}

export function strategyMatches(
  manifest: StrategyManifest,
  inputUrl: string,
  isMainFrame: boolean
): boolean {
  if (manifest.frames === 'top' && !isMainFrame) {
    return false
  }

  let url: URL
  try {
    url = new URL(inputUrl)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false
  }

  return (
    manifest.matches.some((pattern) => urlMatchesPattern(url, pattern)) &&
    !manifest.excludes.some((pattern) => urlMatchesPattern(url, pattern))
  )
}

export function isValidStrategyMatchPattern(pattern: string): boolean {
  return parseMatchPattern(pattern) !== null
}

export function urlMatchesStrategyPattern(
  inputUrl: string,
  pattern: string
): boolean {
  try {
    return urlMatchesPattern(new URL(inputUrl), pattern)
  } catch {
    return false
  }
}

function urlMatchesPattern(url: URL, pattern: string): boolean {
  const parsed = parseMatchPattern(pattern)
  if (!parsed || !parsed.schemes.has(url.protocol as 'http:' | 'https:')) {
    return false
  }

  const hostname = url.hostname.toLowerCase()
  const hostMatches =
    parsed.host === '*' ||
    hostname === parsed.host ||
    (parsed.includeSubdomains && hostname.endsWith(`.${parsed.host}`))
  if (!hostMatches) {
    return false
  }

  if (parsed.port !== null && parsed.port !== '*') {
    const effectivePort = url.port || (url.protocol === 'https:' ? '443' : '80')
    if (effectivePort !== parsed.port) {
      return false
    }
  }

  return parsed.pathExpression.test(`${url.pathname}${url.search}`)
}

function parseMatchPattern(pattern: string): ParsedMatchPattern | null {
  if (pattern === '<all_urls>') {
    return {
      schemes: new Set(['http:', 'https:']),
      host: '*',
      includeSubdomains: false,
      port: '*',
      pathExpression: /^.*$/
    }
  }
  if (pattern.length === 0 || pattern.length > 2_048) {
    return null
  }

  const match = /^(\*|http|https):\/\/([^/]+)(\/.*)$/.exec(pattern)
  if (!match) {
    return null
  }
  const [, scheme, authority, path] = match
  if (!scheme || !authority || !path) {
    return null
  }

  const authorityMatch =
    /^(\*|\*\.[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\*|[0-9]{1,5}))?$/i.exec(
      authority
    )
  if (!authorityMatch) {
    return null
  }
  const rawHost = authorityMatch[1]!.toLowerCase()
  const rawPort = authorityMatch[2] ?? null
  if (
    rawPort !== null &&
    rawPort !== '*' &&
    (Number(rawPort) < 1 || Number(rawPort) > 65_535)
  ) {
    return null
  }

  const includeSubdomains = rawHost.startsWith('*.')
  const host = includeSubdomains ? rawHost.slice(2) : rawHost
  const schemes =
    scheme === '*'
      ? new Set<'http:' | 'https:'>(['http:', 'https:'])
      : new Set<'http:' | 'https:'>([scheme === 'https' ? 'https:' : 'http:'])

  return {
    schemes,
    host,
    includeSubdomains,
    port: rawPort,
    pathExpression: globPathToExpression(path)
  }
}

function globPathToExpression(pattern: string): RegExp {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${escaped}$`)
}
