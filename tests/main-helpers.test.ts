import { describe, expect, it } from 'vitest'

import type {
  ProjectDefinition,
  ProjectRuntimeSnapshot,
  StrategyDefinition
} from '../src/shared/contracts'
import {
  cloneProjectDefinition,
  cloneStrategyDefinitions,
  formatUnknownError,
  isPageViewVisible,
  isTerminalProjectRuntime,
  normalizeComparableUrl,
  parseDownloadIntentPayload,
  parseTakeoverReason,
  toProfileSummaries
} from '../src/main/main-helpers'
import type { ProfileState } from '../src/main/profile-store'

const validIntent = {
  businessItemId: 'post-1',
  attachmentId: 'attach-1',
  sourceUrl: 'https://example.com/file.zip',
  fileName: 'file.zip',
  mime: 'application/zip',
  expectedBytes: 1024
}

describe('parseDownloadIntentPayload', () => {
  it('accepts a well-formed intent and normalises the url', () => {
    expect(parseDownloadIntentPayload(validIntent)).toEqual({
      businessItemId: 'post-1',
      attachmentId: 'attach-1',
      sourceUrl: 'https://example.com/file.zip',
      originalFileName: 'file.zip',
      mime: 'application/zip',
      expectedBytes: 1024
    })
  })

  it('treats a missing expectedBytes as null rather than zero', () => {
    const { expectedBytes: _omitted, ...withoutBytes } = validIntent
    expect(parseDownloadIntentPayload(withoutBytes)?.expectedBytes).toBeNull()
  })

  it('omits mime when the caller does not supply it', () => {
    const { mime: _omitted, ...withoutMime } = validIntent
    expect(parseDownloadIntentPayload(withoutMime)).not.toHaveProperty('mime')
  })

  it('allows an explicit zero byte expectation', () => {
    expect(
      parseDownloadIntentPayload({ ...validIntent, expectedBytes: 0 })
        ?.expectedBytes
    ).toBe(0)
  })

  // 未声明的字段必须被拒绝：策略注入的载荷若夹带额外字段，说明它试图
  // 传递未经约定的数据，宁可拒绝也不要静默忽略。
  it('rejects payloads carrying undeclared keys', () => {
    expect(
      parseDownloadIntentPayload({ ...validIntent, secret: 'leak' })
    ).toBeNull()
  })

  it.each([null, undefined, 'string', 42, [], [validIntent]])(
    'rejects non-object payload %p',
    (value) => {
      expect(parseDownloadIntentPayload(value)).toBeNull()
    }
  )

  it.each(['businessItemId', 'attachmentId', 'sourceUrl', 'fileName'])(
    'rejects a blank %s',
    (key) => {
      expect(
        parseDownloadIntentPayload({ ...validIntent, [key]: '' })
      ).toBeNull()
      expect(
        parseDownloadIntentPayload({ ...validIntent, [key]: '   ' })
      ).toBeNull()
      expect(
        parseDownloadIntentPayload({ ...validIntent, [key]: 123 })
      ).toBeNull()
    }
  )

  it('rejects a blank mime when the key is present', () => {
    expect(
      parseDownloadIntentPayload({ ...validIntent, mime: '  ' })
    ).toBeNull()
  })

  // 非 HTTP(S) 协议必须挡在入口，否则 file:/data: 之类会让下载器去读本地资源。
  it.each([
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'ftp://example.com/file.zip',
    'javascript:alert(1)'
  ])('rejects the non-http(s) url %s', (sourceUrl) => {
    expect(parseDownloadIntentPayload({ ...validIntent, sourceUrl })).toBeNull()
  })

  it('rejects an unparseable url', () => {
    expect(
      parseDownloadIntentPayload({ ...validIntent, sourceUrl: 'not a url' })
    ).toBeNull()
  })

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1024', null])(
    'rejects the invalid expectedBytes %p',
    (expectedBytes) => {
      expect(
        parseDownloadIntentPayload({ ...validIntent, expectedBytes })
      ).toBeNull()
    }
  )
})

describe('normalizeComparableUrl', () => {
  it('drops the hash so two anchors of one page compare equal', () => {
    expect(normalizeComparableUrl('https://example.com/a?x=1#section')).toBe(
      normalizeComparableUrl('https://example.com/a?x=1#other')
    )
  })

  it('keeps the query string, which selects different content', () => {
    expect(normalizeComparableUrl('https://example.com/a?x=1')).not.toBe(
      normalizeComparableUrl('https://example.com/a?x=2')
    )
  })

  it('returns unparseable input unchanged instead of throwing', () => {
    expect(normalizeComparableUrl('not a url')).toBe('not a url')
  })
})

describe('parseTakeoverReason', () => {
  it('uses the trimmed reason when present', () => {
    expect(parseTakeoverReason({ reason: '  disk full  ' }, 'fallback')).toBe(
      'disk full'
    )
  })

  it('falls back for missing, blank, or non-string reasons', () => {
    expect(parseTakeoverReason(undefined, 'fallback')).toBe('fallback')
    expect(parseTakeoverReason({ reason: '   ' }, 'fallback')).toBe('fallback')
    expect(parseTakeoverReason({ reason: 42 }, 'fallback')).toBe('fallback')
    expect(parseTakeoverReason(['reason'], 'fallback')).toBe('fallback')
    expect(parseTakeoverReason('reason', 'fallback')).toBe('fallback')
  })

  // 接管原因会进日志与界面，超长内容必须截断，避免一条脏数据撑爆产物。
  it('caps the reason length', () => {
    const result = parseTakeoverReason({ reason: 'x'.repeat(10_000) }, 'f')
    expect(result).toHaveLength(4_000)
  })
})

describe('formatUnknownError', () => {
  it('uses the message for Error instances', () => {
    expect(formatUnknownError(new Error('boom'))).toBe('boom')
  })

  it('stringifies non-Error throwables', () => {
    expect(formatUnknownError('plain')).toBe('plain')
    expect(formatUnknownError(42)).toBe('42')
    expect(formatUnknownError(null)).toBe('null')
  })
})

describe('isTerminalProjectRuntime', () => {
  const statuses: Array<[ProjectRuntimeSnapshot['status'], boolean]> = [
    ['completed', true],
    ['failed', true],
    ['cancelled', true],
    ['running', false],
    ['queued', false],
    ['paused', false]
  ]

  it.each(statuses)('reports %s as terminal=%s', (status, expected) => {
    const runtime = { status } as ProjectRuntimeSnapshot
    expect(isTerminalProjectRuntime(runtime)).toBe(expected)
  })

  it('treats a missing runtime as non-terminal', () => {
    expect(isTerminalProjectRuntime(null)).toBe(false)
    expect(isTerminalProjectRuntime(undefined)).toBe(false)
  })
})

describe('isPageViewVisible', () => {
  it('hides every page view while an overlay is open', () => {
    // 覆盖层（设置页）打开时，选中的视图也必须让位，否则内嵌网页会盖住设置页。
    expect(isPageViewVisible(true, true)).toBe(false)
    expect(isPageViewVisible(true, false)).toBe(false)
  })

  it('shows only the selected view once the overlay closes', () => {
    expect(isPageViewVisible(false, true)).toBe(true)
    expect(isPageViewVisible(false, false)).toBe(false)
  })
})

describe('toProfileSummaries', () => {
  it('marks only the active profile', () => {
    const state = {
      activeProfileId: 'b',
      profiles: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' }
      ]
    } as unknown as ProfileState

    expect(
      toProfileSummaries(state).map((item) => [item.id, item.active])
    ).toEqual([
      ['a', false],
      ['b', true]
    ])
  })
})

describe('clone helpers', () => {
  it('deep-copies a project definition', () => {
    const project = {
      id: 'p',
      workflow: { nodes: [{ id: 'n' }] }
    } as unknown as ProjectDefinition

    const clone = cloneProjectDefinition(project)
    expect(clone).toEqual(project)
    expect(clone).not.toBe(project)
    expect(clone.workflow).not.toBe(project.workflow)
  })

  it('copies manifest arrays and config so callers cannot mutate the source', () => {
    const definition = {
      id: 's',
      manifest: {
        matches: ['https://a/*'],
        excludes: ['https://a/b'],
        permissions: ['dom.read'],
        networkMatches: ['https://a/api'],
        config: { nested: { value: 1 } },
        timeouts: { startupMs: 1, heartbeatMs: 2 }
      }
    } as unknown as StrategyDefinition

    const clones = cloneStrategyDefinitions([definition])
    expect(clones).toHaveLength(1)
    const clone = clones[0]!

    expect(clone.manifest).toEqual(definition.manifest)
    expect(clone.manifest).not.toBe(definition.manifest)
    expect(clone.manifest.matches).not.toBe(definition.manifest.matches)
    expect(clone.manifest.config).not.toBe(definition.manifest.config)
    expect(clone.manifest.config.nested).not.toBe(
      definition.manifest.config.nested
    )

    clone.manifest.matches.push('https://evil/*')
    clone.manifest.config.nested = { value: 2 }
    expect(definition.manifest.matches).toEqual(['https://a/*'])
    expect(definition.manifest.config.nested).toEqual({ value: 1 })
  })
})
