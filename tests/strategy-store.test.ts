import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { StrategyManifest } from '../src/shared/contracts'
import {
  emptyStrategyState,
  parseStrategyManifest,
  StrategyStore
} from '../src/main/strategy-store'

describe('StrategyStore', () => {
  let temporaryRoot: string
  let filePath: string

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'agentic-strategy-test-'))
    filePath = join(temporaryRoot, 'strategies.json')
  })

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true })
  })

  it('starts with an empty versioned registry', async () => {
    await expect(new StrategyStore(filePath).read()).resolves.toEqual(
      emptyStrategyState()
    )
  })

  it('saves, sorts, and reloads fully validated definitions', async () => {
    const store = new StrategyStore(filePath)
    await store.save(createDraft('z-strategy'))
    const state = await store.save(createDraft('a-strategy'))

    expect(
      state.strategies.map((strategy) => strategy.manifest.id)
    ).toEqual(['a-strategy', 'z-strategy'])
    expect(state.strategies[0]?.updatedAt).toBeTruthy()
    await expect(store.read()).resolves.toEqual(state)
  })

  it('serializes concurrent updates without losing definitions', async () => {
    const store = new StrategyStore(filePath)
    await Promise.all([
      store.save(createDraft('one')),
      store.save(createDraft('two')),
      store.save(createDraft('three'))
    ])

    const state = await store.read()
    expect(state.strategies.map((item) => item.manifest.id)).toEqual([
      'one',
      'three',
      'two'
    ])
  })

  it('updates enabled state and deletes only existing strategies', async () => {
    const store = new StrategyStore(filePath)
    await store.save(createDraft('feed-scanner'))

    const disabled = await store.setEnabled('feed-scanner', false)
    expect(disabled.strategies[0]?.enabled).toBe(false)
    await expect(store.delete('missing')).rejects.toThrow(
      'Strategy 不存在'
    )
    await expect(store.delete('feed-scanner')).resolves.toEqual(
      emptyStrategyState()
    )
  })

  it('rejects unknown fields, permissions, duplicate patterns, and invalid JSON config', () => {
    const manifest = createManifest('feed-scanner')
    expect(
      parseStrategyManifest({ ...manifest, shellCommand: 'rm -rf /' })
    ).toBeNull()
    expect(
      parseStrategyManifest({
        ...manifest,
        permissions: ['dom.read', 'shell']
      })
    ).toBeNull()
    expect(
      parseStrategyManifest({
        ...manifest,
        matches: [manifest.matches[0], manifest.matches[0]]
      })
    ).toBeNull()
    expect(
      parseStrategyManifest({
        ...manifest,
        config: { threshold: Number.NaN }
      })
    ).toBeNull()
  })

  it('quarantines malformed or semantically invalid registry files', async () => {
    const store = new StrategyStore(filePath)
    await writeFile(filePath, '{broken', 'utf8')
    await expect(store.read()).resolves.toEqual(emptyStrategyState())

    const malformedFiles = await readdir(temporaryRoot)
    expect(
      malformedFiles.some((name) =>
        name.startsWith('strategies.json.invalid-')
      )
    ).toBe(true)

    await writeFile(
      filePath,
      JSON.stringify({ schemaVersion: 1, strategies: [{ id: 'wrong' }] }),
      'utf8'
    )
    await expect(store.read()).resolves.toEqual(emptyStrategyState())
    await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})

function createManifest(id: string): StrategyManifest {
  return {
    id,
    name: id,
    version: '0.1.0',
    matches: ['https://example.com/feed/*'],
    excludes: [],
    runAt: 'document-idle',
    frames: 'top',
    permissions: ['dom.read', 'log'],
    networkMatches: [],
    config: {
      keywords: ['meeting', 'audio']
    },
    timeouts: {
      startupMs: 10_000,
      heartbeatMs: 30_000
    }
  }
}

function createDraft(id: string): {
  manifest: StrategyManifest
  source: string
  enabled: boolean
} {
  return {
    manifest: createManifest(id),
    source: 'agenticStrategy.log("ready")',
    enabled: true
  }
}
