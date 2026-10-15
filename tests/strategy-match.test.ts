import { describe, expect, it } from 'vitest'

import type {
  StrategyDefinition,
  StrategyManifest
} from '../src/shared/contracts'
import {
  isValidStrategyMatchPattern,
  resolveMatchingStrategies,
  strategyMatches,
  urlMatchesStrategyPattern
} from '../src/main/strategy-match'

describe('Strategy URL matcher', () => {
  it('validates structured HTTP(S) patterns and rejects unsafe forms', () => {
    expect(isValidStrategyMatchPattern('https://example.com/feed/*')).toBe(
      true
    )
    expect(isValidStrategyMatchPattern('*://*.example.com:*/feed/*')).toBe(
      true
    )
    expect(isValidStrategyMatchPattern('<all_urls>')).toBe(true)
    expect(isValidStrategyMatchPattern('file:///*')).toBe(false)
    expect(
      isValidStrategyMatchPattern('https://user:pass@example.com/*')
    ).toBe(false)
    expect(isValidStrategyMatchPattern('https://example.com:70000/*')).toBe(
      false
    )
  })

  it('matches exact hosts, effective default ports, paths, and queries', () => {
    expect(
      urlMatchesStrategyPattern(
        'https://example.com/feed/items?kind=audio',
        'https://example.com:443/feed/*'
      )
    ).toBe(true)
    expect(
      urlMatchesStrategyPattern(
        'https://example.com/other',
        'https://example.com/feed/*'
      )
    ).toBe(false)
  })

  it('supports scheme, subdomain, and port wildcards without crossing domains', () => {
    const pattern = '*://*.example.com:*/feed/*'
    expect(
      urlMatchesStrategyPattern('http://example.com:8080/feed/1', pattern)
    ).toBe(true)
    expect(
      urlMatchesStrategyPattern(
        'https://a.b.example.com/feed/1',
        pattern
      )
    ).toBe(true)
    expect(
      urlMatchesStrategyPattern('https://notexample.com/feed/1', pattern)
    ).toBe(false)
  })

  it('lets excludes override matches and honors top-frame scope', () => {
    const manifest = createManifest({
      excludes: ['https://example.com/feed/private/*']
    })
    expect(
      strategyMatches(manifest, 'https://example.com/feed/public/1', true)
    ).toBe(true)
    expect(
      strategyMatches(manifest, 'https://example.com/feed/private/1', true)
    ).toBe(false)
    expect(
      strategyMatches(manifest, 'https://example.com/feed/public/1', false)
    ).toBe(false)
  })

  it('requires enabled state and explicit allowlist in addition to URL match', () => {
    const allowed = createDefinition('allowed', true)
    const disabled = createDefinition('disabled', false)
    const notAllowed = createDefinition('not-allowed', true)

    expect(
      resolveMatchingStrategies([notAllowed, disabled, allowed], {
        url: 'https://example.com/feed/1',
        isMainFrame: true,
        allowedStrategyIds: new Set(['allowed', 'disabled'])
      }).map((definition) => definition.manifest.id)
    ).toEqual(['allowed'])
  })

  it('fails closed for malformed or non-web URLs', () => {
    const manifest = createManifest()
    expect(strategyMatches(manifest, 'not a URL', true)).toBe(false)
    expect(strategyMatches(manifest, 'file:///tmp/feed/1', true)).toBe(false)
  })
})

function createManifest(
  overrides: Partial<StrategyManifest> = {}
): StrategyManifest {
  return {
    id: 'feed-scanner',
    name: 'Feed Scanner',
    version: '0.1.0',
    matches: ['https://example.com/feed/*'],
    excludes: [],
    runAt: 'document-idle',
    frames: 'top',
    permissions: ['dom.read', 'log'],
    networkMatches: [],
    config: {},
    timeouts: {
      startupMs: 10_000,
      heartbeatMs: 30_000
    },
    ...overrides
  }
}

function createDefinition(
  id: string,
  enabled: boolean
): StrategyDefinition {
  return {
    manifest: createManifest({ id }),
    source: '',
    enabled,
    updatedAt: '2026-10-15T00:00:00.000Z'
  }
}
