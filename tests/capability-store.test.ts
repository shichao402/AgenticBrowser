import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CapabilityStore,
  createCapabilityPolicy,
  DEFAULT_CAPABILITIES,
  normalizeCapabilityOrigin,
  parseCapabilityPolicy,
  parseCapabilitySettings,
  resolveCapabilitySettings
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
    await expect(store.read()).resolves.toEqual(createCapabilityPolicy())
  })

  it('persists a validated default policy and sorted exact-origin rules', async () => {
    const store = new CapabilityStore(join(temporaryRoot, 'capabilities.json'))
    const policy = {
      schemaVersion: 1 as const,
      defaults: {
        ...DEFAULT_CAPABILITIES,
        media: true
      },
      origins: [
        {
          origin: 'https://z.example',
          overrides: { downloads: false }
        },
        {
          origin: 'https://a.example',
          overrides: { popups: true, media: false }
        }
      ]
    }

    const expected = {
      ...policy,
      origins: [policy.origins[1], policy.origins[0]]
    }
    await expect(store.write(policy)).resolves.toEqual(expected)
    await expect(store.read()).resolves.toEqual(expected)
  })

  it('migrates the legacy flat settings without losing choices', async () => {
    const store = new CapabilityStore(join(temporaryRoot, 'capabilities.json'))
    const settings = {
      ...DEFAULT_CAPABILITIES,
      popups: true
    }
    await writeJson(join(temporaryRoot, 'capabilities.json'), settings)

    await expect(store.read()).resolves.toEqual(
      createCapabilityPolicy(settings)
    )
  })

  it('rejects partial, extra, or non-boolean settings', () => {
    expect(parseCapabilitySettings({ downloads: true })).toBeNull()
    expect(
      parseCapabilitySettings({
        ...DEFAULT_CAPABILITIES,
        geolocation: 'allow'
      })
    ).toBeNull()
    expect(
      parseCapabilitySettings({
        ...DEFAULT_CAPABILITIES,
        shell: true
      })
    ).toBeNull()
  })

  it('normalizes page URLs but policy parser requires canonical origins', () => {
    expect(normalizeCapabilityOrigin('https://EXAMPLE.com:443/path?q=1')).toBe(
      'https://example.com'
    )
    expect(normalizeCapabilityOrigin('file:///tmp/test')).toBeNull()
    expect(
      parseCapabilityPolicy({
        ...createCapabilityPolicy(),
        origins: [
          {
            origin: 'https://example.com/path',
            overrides: { media: true }
          }
        ]
      })
    ).toBeNull()
    expect(
      parseCapabilityPolicy({
        ...createCapabilityPolicy(),
        defaultz: DEFAULT_CAPABILITIES
      })
    ).toBeNull()
  })

  it('resolves only the exact requesting origin and otherwise inherits defaults', () => {
    const policy = {
      ...createCapabilityPolicy(),
      origins: [
        {
          origin: 'https://example.com',
          overrides: {
            popups: true,
            downloads: false
          }
        }
      ]
    }

    expect(
      resolveCapabilitySettings(policy, 'https://example.com/page').popups
    ).toBe(true)
    expect(
      resolveCapabilitySettings(policy, 'https://example.com/page').downloads
    ).toBe(false)
    expect(
      resolveCapabilitySettings(policy, 'https://sub.example.com/page')
    ).toEqual(DEFAULT_CAPABILITIES)
    expect(resolveCapabilitySettings(policy, 'data:text/html,test')).toEqual(
      DEFAULT_CAPABILITIES
    )
  })
})

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), 'utf8')
}
