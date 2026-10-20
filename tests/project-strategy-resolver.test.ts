import { describe, expect, it } from 'vitest'

import {
  requireRunnableProjectStrategies,
  resolveProjectStrategies
} from '../src/main/project-strategy-resolver'
import type { StrategyDefinition } from '../src/shared/contracts'
import { createProjectDefinition } from './project-fixture'

describe('project strategy resolver', () => {
  it('resolves only exact enabled version pins', () => {
    const project = createProject({
      alpha: '1.0.0',
      beta: '2.0.0'
    })
    const resolved = resolveProjectStrategies(project, [
      createStrategy('alpha', '1.0.0', true),
      createStrategy('beta', '2.1.0', true),
      createStrategy('unlisted', '1.0.0', true)
    ])

    expect(resolved.definitions.map((item) => item.manifest.id)).toEqual([
      'alpha'
    ])
    expect([...resolved.allowedStrategyIds]).toEqual(['alpha'])
    expect(resolved.resolutions).toEqual([
      {
        strategyId: 'alpha',
        pinnedVersion: '1.0.0',
        registryVersion: '1.0.0',
        status: 'ready',
        runnable: true
      },
      {
        strategyId: 'beta',
        pinnedVersion: '2.0.0',
        registryVersion: '2.1.0',
        status: 'version-mismatch',
        runnable: false
      }
    ])
  })

  it('fails closed for missing, mismatched, and disabled pins', () => {
    const resolved = resolveProjectStrategies(
      createProject({
        disabled: '1.0.0',
        missing: '1.0.0',
        stale: '1.0.0'
      }),
      [
        createStrategy('disabled', '1.0.0', false),
        createStrategy('stale', '2.0.0', true)
      ]
    )

    expect(() => requireRunnableProjectStrategies(resolved)).toThrow(
      /已禁用.*不存在.*需要 1\.0\.0/
    )
    expect(resolved.allowedStrategyIds.size).toBe(0)
  })

  it('allows a page-only project with no strategy pins', () => {
    const resolved = resolveProjectStrategies(createProject({}), [])
    expect(() => requireRunnableProjectStrategies(resolved)).not.toThrow()
    expect(resolved.resolutions).toEqual([])
  })
})

function createProject(strategies: Record<string, string>) {
  return createProjectDefinition(
    Object.entries(strategies).map(([id, version]) => ({
      id,
      version
    }))
  )
}

function createStrategy(
  id: string,
  version: string,
  enabled: boolean
): StrategyDefinition {
  return {
    manifest: {
      id,
      name: id,
      version,
      matches: ['<all_urls>'],
      excludes: [],
      runAt: 'document-idle',
      frames: 'top',
      permissions: [],
      networkMatches: [],
      config: {},
      timeouts: {
        startupMs: 1_000,
        heartbeatMs: 1_000
      }
    },
    source: '',
    enabled,
    updatedAt: '2026-10-15T00:00:00.000Z'
  }
}
