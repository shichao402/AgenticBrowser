import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  emptyStrategyPolicy,
  StrategyPolicyStore
} from '../src/main/strategy-policy-store'

describe('StrategyPolicyStore', () => {
  let temporaryRoot: string
  let filePath: string

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'agentic-policy-test-'))
    filePath = join(temporaryRoot, 'strategy-policy.json')
  })

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true })
  })

  it('defaults to an empty explicit development allowlist', async () => {
    await expect(new StrategyPolicyStore(filePath).read()).resolves.toEqual(
      emptyStrategyPolicy()
    )
  })

  it('serializes concurrent changes and keeps a sorted unique allowlist', async () => {
    const store = new StrategyPolicyStore(filePath)
    await Promise.all([
      store.setAllowed('z-last', true),
      store.setAllowed('a-first', true),
      store.setAllowed('middle', true)
    ])
    await store.setAllowed('middle', true)

    await expect(store.read()).resolves.toEqual({
      schemaVersion: 1,
      developmentAllowedStrategyIds: ['a-first', 'middle', 'z-last']
    })
    await expect(store.remove('middle')).resolves.toEqual({
      schemaVersion: 1,
      developmentAllowedStrategyIds: ['a-first', 'z-last']
    })
  })

  it('quarantines invalid policy files and fails closed', async () => {
    await writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        developmentAllowedStrategyIds: ['valid', 'valid']
      }),
      'utf8'
    )
    const store = new StrategyPolicyStore(filePath)

    await expect(store.read()).resolves.toEqual(emptyStrategyPolicy())
    expect(
      (await readdir(temporaryRoot)).some((name) =>
        name.startsWith('strategy-policy.json.invalid-')
      )
    ).toBe(true)
  })
})
