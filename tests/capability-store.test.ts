import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CapabilityStore,
  DEFAULT_CAPABILITIES,
  parseCapabilitySettings
} from '../src/main/capability-store'

describe('CapabilityStore', () => {
  let temporaryRoot: string

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'agentic-capability-test-'))
  })

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true })
  })

  it('defaults to deny except project-scoped downloads', async () => {
    const store = new CapabilityStore(join(temporaryRoot, 'capabilities.json'))
    await expect(store.read()).resolves.toEqual(DEFAULT_CAPABILITIES)
  })

  it('persists a fully validated capability set', async () => {
    const store = new CapabilityStore(join(temporaryRoot, 'capabilities.json'))
    const settings = {
      ...DEFAULT_CAPABILITIES,
      popups: true,
      media: true
    }

    await expect(store.write(settings)).resolves.toEqual(settings)
    await expect(store.read()).resolves.toEqual(settings)
  })

  it('rejects partial or non-boolean settings', () => {
    expect(parseCapabilitySettings({ downloads: true })).toBeNull()
    expect(
      parseCapabilitySettings({
        ...DEFAULT_CAPABILITIES,
        geolocation: 'allow'
      })
    ).toBeNull()
  })
})
