import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ProfileStore, parseProfileState } from '../src/main/profile-store'

describe('ProfileStore', () => {
  let temporaryRoot: string
  let store: ProfileStore

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'agentic-profile-test-'))
    store = new ProfileStore(join(temporaryRoot, 'profiles.json'))
  })

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true })
  })

  it('provides a persistent default profile', async () => {
    await expect(store.read()).resolves.toMatchObject({
      schemaVersion: 1,
      activeProfileId: 'profile-default',
      profiles: [{ id: 'profile-default', name: '默认 Profile' }]
    })
  })

  it('creates, activates, and deletes an inactive named profile', async () => {
    const created = await store.create('知识星球账号')
    const profile = created.profiles.find(
      (item) => item.id !== 'profile-default'
    )
    expect(profile?.name).toBe('知识星球账号')

    const active = await store.setActive(profile!.id)
    expect(active.activeProfileId).toBe(profile!.id)
    await expect(store.delete(profile!.id)).rejects.toThrow('活动 Profile')

    await store.setActive('profile-default')
    const deleted = await store.delete(profile!.id)
    expect(deleted.profiles).toHaveLength(1)
  })

  it('protects the default profile and validates persisted state', async () => {
    await expect(store.delete('profile-default')).rejects.toThrow(
      '默认 Profile'
    )
    expect(
      parseProfileState({
        schemaVersion: 1,
        activeProfileId: 'missing',
        profiles: []
      })
    ).toBeNull()
  })

  it('serializes concurrent profile mutations', async () => {
    await Promise.all([store.create('A'), store.create('B'), store.create('C')])
    const state = await store.read()
    expect(state.profiles.map((profile) => profile.name)).toEqual([
      '默认 Profile',
      'A',
      'B',
      'C'
    ])
  })
})
