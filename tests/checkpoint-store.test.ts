import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  BROWSER_CHECKPOINT_SCHEMA_VERSION,
  BrowserCheckpointStore
} from '../src/main/checkpoint-store'

describe('BrowserCheckpointStore', () => {
  let temporaryRoot: string
  let checkpointPath: string

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'agentic-checkpoint-test-'))
    checkpointPath = join(temporaryRoot, 'runtime', 'checkpoint.json')
  })

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true })
  })

  it('atomically persists and reads a validated checkpoint', async () => {
    const store = new BrowserCheckpointStore(checkpointPath)
    const saved = await store.write({
      profileId: 'project_alpha',
      url: 'https://example.com/feed',
      reason: 'navigation-finished'
    })

    expect(saved).toMatchObject({
      schemaVersion: BROWSER_CHECKPOINT_SCHEMA_VERSION,
      profileId: 'project_alpha',
      url: 'https://example.com/feed',
      reason: 'navigation-finished'
    })
    expect(await store.read()).toEqual(saved)
  })

  it('serializes concurrent writes so the latest checkpoint wins', async () => {
    const store = new BrowserCheckpointStore(checkpointPath)
    await Promise.all([
      store.write({
        profileId: 'default',
        url: 'https://example.com/first',
        reason: 'first'
      }),
      store.write({
        profileId: 'default',
        url: 'https://example.com/second',
        reason: 'second'
      })
    ])

    expect(await store.read()).toMatchObject({
      url: 'https://example.com/second',
      reason: 'second'
    })
  })

  it('quarantines malformed state instead of crash-looping', async () => {
    await mkdir(join(temporaryRoot, 'runtime'), { recursive: true })
    await writeFile(checkpointPath, '{not valid json', 'utf8')
    const store = new BrowserCheckpointStore(checkpointPath)

    await expect(store.read()).resolves.toBeNull()
    const files = await readdir(join(temporaryRoot, 'runtime'))
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^checkpoint\.json\.corrupt-/)
  })

  it('rejects unsafe URLs and invalid profile IDs', async () => {
    const store = new BrowserCheckpointStore(checkpointPath)

    await expect(
      store.write({
        profileId: '../other-profile',
        url: 'https://example.com/',
        reason: 'test'
      })
    ).rejects.toThrow('Profile ID')
    await expect(
      store.write({
        profileId: 'default',
        url: 'file:///etc/passwd',
        reason: 'test'
      })
    ).rejects.toThrow('不允许导航')
  })
})
