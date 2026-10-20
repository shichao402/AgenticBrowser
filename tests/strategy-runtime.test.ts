import { describe, expect, it, vi } from 'vitest'

import type {
  JsonValue,
  StrategyDefinition,
  StrategyManifest,
  StrategyNetworkRequest
} from '../src/shared/contracts'
import {
  StrategyRuntime,
  type StrategyFrameContext
} from '../src/main/strategy-runtime'

const MAIN_FRAME: StrategyFrameContext = {
  frameTreeNodeId: 10,
  url: 'https://example.com/feed/1',
  isMainFrame: true
}

describe('StrategyRuntime', () => {
  it('requires enabled, allowlisted, matched, and non-quarantined definitions', () => {
    const runtime = createRuntime({
      definitions: [
        createDefinition('allowed'),
        createDefinition('not-allowed'),
        createDefinition('disabled', { enabled: false }),
        createDefinition('excluded', {
          manifest: {
            excludes: ['https://example.com/feed/*']
          }
        })
      ],
      allowedStrategyIds: new Set([
        'allowed',
        'disabled',
        'excluded',
        'quarantined'
      ]),
      quarantinedStrategyIds: new Set(['quarantined'])
    })

    const response = runtime.bootstrap(MAIN_FRAME)
    expect(response.entries.map((entry) => entry.strategyId)).toEqual([
      'allowed'
    ])
    expect(response.entries[0]).toMatchObject({
      runAt: 'document-idle',
      config: { marker: 'allowed' }
    })
  })

  it('keeps each strategy in a stable distinct isolated world', () => {
    const runtime = createRuntime({
      definitions: [createDefinition('z-last'), createDefinition('a-first')],
      allowedStrategyIds: new Set(['z-last', 'a-first'])
    })

    const first = runtime.bootstrap(MAIN_FRAME)
    const worlds = Object.fromEntries(
      first.entries.map((entry) => [entry.strategyId, entry.worldId])
    )
    expect(worlds).toEqual({
      'a-first': 1001,
      'z-last': 1002
    })

    const second = runtime.bootstrap(MAIN_FRAME)
    expect(
      Object.fromEntries(
        second.entries.map((entry) => [entry.strategyId, entry.worldId])
      )
    ).toEqual(worlds)
    expect(second.entries[0]?.token).not.toBe(first.entries[0]?.token)
  })

  it('tracks lifecycle and validates the issuing frame', () => {
    let now = 1_000
    const events: string[] = []
    const runtime = createRuntime({
      definitions: [createDefinition('feed-scanner')],
      allowedStrategyIds: new Set(['feed-scanner']),
      now: () => now,
      onEvent: (event) => events.push(event.type)
    })
    const entry = runtime.bootstrap(MAIN_FRAME).entries[0]!

    expect(
      runtime.signal(
        { ...MAIN_FRAME, frameTreeNodeId: 11 },
        { token: entry.token, type: 'started' }
      )
    ).toBe(false)
    expect(
      runtime.signal(MAIN_FRAME, {
        token: entry.token,
        type: 'installed'
      })
    ).toBe(true)
    expect(runtime.getSnapshot().entries[0]?.status).toBe('scheduled')

    now = 1_100
    runtime.signal(MAIN_FRAME, { token: entry.token, type: 'started' })
    now = 1_200
    runtime.signal(MAIN_FRAME, { token: entry.token, type: 'ready' })
    now = 1_300
    runtime.signal(MAIN_FRAME, { token: entry.token, type: 'heartbeat' })

    expect(runtime.getSnapshot()).toMatchObject({
      activeCount: 1,
      entries: [
        {
          strategyId: 'feed-scanner',
          status: 'running',
          startedAt: new Date(1_100).toISOString(),
          lastHeartbeatAt: new Date(1_300).toISOString()
        }
      ]
    })
    expect(events).toEqual(['strategy-started', 'strategy-ready'])
  })

  it('enforces host permissions and emits bounded logs and domain events', async () => {
    const events: Array<{ type: string; detail: string }> = []
    const domainEvents: Array<{
      strategyId: string
      name: string
      payload?: JsonValue
      url: string
    }> = []
    const runtime = createRuntime({
      definitions: [
        createDefinition('reporter', {
          manifest: {
            permissions: ['dom.read', 'log', 'project.emit-event']
          }
        })
      ],
      allowedStrategyIds: new Set(['reporter']),
      onEvent: (event) => events.push(event),
      onDomainEvent: (event) => {
        domainEvents.push(event)
      }
    })
    const entry = startStrategy(runtime)

    await expect(
      runtime.invoke(MAIN_FRAME, {
        token: entry.token,
        method: 'log',
        payload: {
          level: 'info',
          message: 'ready',
          data: { count: 2 }
        }
      })
    ).resolves.toBeNull()
    await expect(
      runtime.invoke(MAIN_FRAME, {
        token: entry.token,
        method: 'emit-event',
        payload: {
          name: 'feed.item-found',
          payload: { itemId: '42' }
        }
      })
    ).resolves.toBeNull()
    await expect(
      runtime.invoke(MAIN_FRAME, {
        token: entry.token,
        method: 'network-request',
        payload: { url: 'https://api.example.com/items' }
      })
    ).rejects.toThrow('未声明 network.request')

    expect(events.map((event) => event.type)).toEqual([
      'strategy-started',
      'strategy-ready',
      'strategy-log',
      'strategy-event'
    ])
    expect(events[2]?.detail).toContain('ready')
    expect(events[3]?.detail).toContain('feed.item-found')
    expect(domainEvents).toEqual([
      {
        strategyId: 'reporter',
        name: 'feed.item-found',
        payload: { itemId: '42' },
        url: MAIN_FRAME.url
      }
    ])
  })

  it('waits for and returns a JSON domain-event acknowledgement', async () => {
    const runtime = createRuntime({
      definitions: [
        createDefinition('downloader', {
          manifest: {
            permissions: ['project.emit-event']
          }
        })
      ],
      allowedStrategyIds: new Set(['downloader']),
      onDomainEvent: async (event) => ({
        accepted: event.name === 'download.intent',
        downloadId: 'download-12345678'
      })
    })
    const entry = startStrategy(runtime)

    await expect(
      runtime.invoke(MAIN_FRAME, {
        token: entry.token,
        method: 'emit-event',
        payload: {
          name: 'download.intent',
          payload: { sourceUrl: 'https://example.com/file.mp3' }
        }
      })
    ).resolves.toEqual({
      accepted: true,
      downloadId: 'download-12345678'
    })
  })

  it('restricts privileged network requests to manifest URL patterns', async () => {
    const requestNetwork = vi.fn(
      async (
        _definition: StrategyDefinition,
        request: StrategyNetworkRequest
      ) => ({
        url: request.url,
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"ok":true}'
      })
    )
    const runtime = createRuntime({
      definitions: [
        createDefinition('networked', {
          manifest: {
            permissions: ['network.request'],
            networkMatches: ['https://api.example.com/v1/*']
          }
        })
      ],
      allowedStrategyIds: new Set(['networked']),
      requestNetwork
    })
    const entry = startStrategy(runtime)

    await expect(
      runtime.invoke(MAIN_FRAME, {
        token: entry.token,
        method: 'network-request',
        payload: {
          url: 'https://api.example.com/v1/items',
          method: 'POST',
          body: '{"name":"demo"}'
        }
      })
    ).resolves.toMatchObject({ status: 200 })
    await expect(
      runtime.invoke(MAIN_FRAME, {
        token: entry.token,
        method: 'network-request',
        payload: { url: 'https://evil.example/v1/items' }
      })
    ).rejects.toThrow('未命中 allowlist')
    expect(requestNetwork).toHaveBeenCalledTimes(1)
  })

  it('reports startup and heartbeat timeouts once', () => {
    let now = 1_000
    const faults: Array<{ id: string; reason: string }> = []
    const events: string[] = []
    const runtime = createRuntime({
      definitions: [
        createDefinition('blocking', {
          manifest: {
            timeouts: { startupMs: 100, heartbeatMs: 500 }
          }
        })
      ],
      allowedStrategyIds: new Set(['blocking']),
      now: () => now,
      onFault: (id, reason) => faults.push({ id, reason }),
      onEvent: (event) => events.push(event.type)
    })
    const entry = runtime.bootstrap(MAIN_FRAME).entries[0]!
    runtime.signal(MAIN_FRAME, { token: entry.token, type: 'started' })

    now = 1_101
    runtime.checkHealth()
    runtime.checkHealth()

    expect(runtime.getSnapshot()).toMatchObject({
      activeCount: 0,
      entries: [{ status: 'failed', failure: '启动超过 100 ms' }]
    })
    expect(faults).toEqual([{ id: 'blocking', reason: '启动超过 100 ms' }])
    expect(events).toEqual(['strategy-started', 'strategy-heartbeat-missed'])
  })

  it('does not apply the startup timeout while waiting for run-at', () => {
    let now = 1_000
    const faults: string[] = []
    const runtime = createRuntime({
      definitions: [
        createDefinition('wait-for-dom', {
          manifest: {
            timeouts: { startupMs: 100, heartbeatMs: 500 }
          }
        })
      ],
      allowedStrategyIds: new Set(['wait-for-dom']),
      now: () => now,
      onFault: (id) => faults.push(id)
    })
    const entry = runtime.bootstrap(MAIN_FRAME).entries[0]!
    runtime.signal(MAIN_FRAME, { token: entry.token, type: 'installed' })

    now = 10_000
    runtime.checkHealth()

    expect(runtime.getSnapshot().entries[0]?.status).toBe('scheduled')
    expect(faults).toEqual([])
  })

  it('audits main-world execution and rejects it without permission', async () => {
    const runtime = createRuntime({
      definitions: [
        createDefinition('isolated-only', {
          manifest: { permissions: ['dom.read'] }
        }),
        createDefinition('main-world', {
          manifest: { permissions: ['main-world'] }
        })
      ],
      allowedStrategyIds: new Set(['isolated-only', 'main-world'])
    })
    const entries = runtime.bootstrap(MAIN_FRAME).entries
    for (const entry of entries) {
      runtime.signal(MAIN_FRAME, {
        token: entry.token,
        type: 'started'
      })
    }

    await expect(
      runtime.invoke(MAIN_FRAME, {
        token: entries.find((entry) => entry.strategyId === 'isolated-only')!
          .token,
        method: 'main-world-eval',
        payload: { sourceLength: 10 }
      })
    ).rejects.toThrow('未声明 main-world')
    await expect(
      runtime.invoke(MAIN_FRAME, {
        token: entries.find((entry) => entry.strategyId === 'main-world')!
          .token,
        method: 'main-world-eval',
        payload: { sourceLength: 10 }
      })
    ).resolves.toBeNull()
  })

  it('does not expose manifest config without config.read', () => {
    const runtime = createRuntime({
      definitions: [
        createDefinition('no-config', {
          manifest: { permissions: ['dom.read'] }
        })
      ],
      allowedStrategyIds: new Set(['no-config'])
    })
    expect(runtime.bootstrap(MAIN_FRAME).entries[0]?.config).toEqual({})
  })
})

function createRuntime(
  overrides: Partial<ConstructorParameters<typeof StrategyRuntime>[0]> = {}
): StrategyRuntime {
  let tokenSequence = 0
  return new StrategyRuntime({
    definitions: [createDefinition('default-strategy')],
    allowedStrategyIds: new Set(['default-strategy']),
    createToken: () => `strategy-token-${++tokenSequence}`.padEnd(20, 'x'),
    ...overrides
  })
}

function startStrategy(runtime: StrategyRuntime) {
  const entry = runtime.bootstrap(MAIN_FRAME).entries[0]!
  runtime.signal(MAIN_FRAME, { token: entry.token, type: 'installed' })
  runtime.signal(MAIN_FRAME, { token: entry.token, type: 'started' })
  runtime.signal(MAIN_FRAME, { token: entry.token, type: 'ready' })
  return entry
}

function createDefinition(
  id: string,
  overrides: {
    enabled?: boolean
    manifest?: Partial<StrategyManifest>
  } = {}
): StrategyDefinition {
  const manifest: StrategyManifest = {
    id,
    name: id,
    version: '0.1.0',
    matches: ['https://example.com/feed/*'],
    excludes: [],
    runAt: 'document-idle',
    frames: 'top',
    permissions: ['dom.read', 'config.read'],
    networkMatches: [],
    config: { marker: id },
    timeouts: {
      startupMs: 10_000,
      heartbeatMs: 30_000
    },
    ...overrides.manifest
  }
  return {
    manifest,
    source: 'agenticStrategy.log?.("ready")',
    enabled: overrides.enabled ?? true,
    updatedAt: '2026-10-15T00:00:00.000Z'
  }
}
