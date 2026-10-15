import { randomUUID } from 'node:crypto'

import { readJsonFile, writeJsonAtomic } from './atomic-file'

export interface ProfileRecord {
  id: string
  name: string
  createdAt: string
}

export interface ProfileState {
  schemaVersion: 1
  activeProfileId: string
  profiles: ProfileRecord[]
}

export const DEFAULT_PROFILE_ID = 'profile-default'

const DEFAULT_PROFILE: ProfileRecord = {
  id: DEFAULT_PROFILE_ID,
  name: '默认 Profile',
  createdAt: '2026-10-15T00:00:00.000Z'
}

export class ProfileStore {
  private queue = Promise.resolve()

  constructor(readonly filePath: string) {}

  async read(): Promise<ProfileState> {
    const value = await readJsonFile(this.filePath)
    return parseProfileState(value) ?? defaultProfileState()
  }

  async create(name: string): Promise<ProfileState> {
    return this.update((state) => {
      const normalizedName = normalizeProfileName(name)
      const id = createProfileId(normalizedName)
      return {
        ...state,
        profiles: [
          ...state.profiles,
          {
            id,
            name: normalizedName,
            createdAt: new Date().toISOString()
          }
        ]
      }
    })
  }

  async setActive(profileId: string): Promise<ProfileState> {
    return this.update((state) => {
      requireProfile(state, profileId)
      return {
        ...state,
        activeProfileId: profileId
      }
    })
  }

  async delete(profileId: string): Promise<ProfileState> {
    return this.update((state) => {
      requireProfile(state, profileId)
      if (profileId === DEFAULT_PROFILE.id) {
        throw new Error('默认 Profile 不能删除')
      }
      if (profileId === state.activeProfileId) {
        throw new Error('活动 Profile 不能删除')
      }
      return {
        ...state,
        profiles: state.profiles.filter((profile) => profile.id !== profileId)
      }
    })
  }

  private async update(
    transform: (state: ProfileState) => ProfileState
  ): Promise<ProfileState> {
    let result: ProfileState | null = null
    const operation = this.queue.then(async () => {
      const current = await this.read()
      result = transform(current)
      await writeJsonAtomic(this.filePath, result)
    })
    this.queue = operation.catch(() => undefined)
    await operation
    return result!
  }
}

export function parseProfileState(value: unknown): ProfileState | null {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return null
  }
  if (
    typeof value.activeProfileId !== 'string' ||
    !Array.isArray(value.profiles) ||
    value.profiles.length === 0
  ) {
    return null
  }

  const profiles: ProfileRecord[] = []
  const ids = new Set<string>()
  for (const profile of value.profiles) {
    if (
      !isRecord(profile) ||
      typeof profile.id !== 'string' ||
      typeof profile.name !== 'string' ||
      typeof profile.createdAt !== 'string' ||
      !isProfileId(profile.id) ||
      profile.name.trim().length === 0 ||
      profile.name.trim().length > 80 ||
      Number.isNaN(Date.parse(profile.createdAt)) ||
      ids.has(profile.id)
    ) {
      return null
    }
    ids.add(profile.id)
    profiles.push({
      id: profile.id,
      name: profile.name.trim(),
      createdAt: profile.createdAt
    })
  }

  if (!ids.has(value.activeProfileId) || !ids.has(DEFAULT_PROFILE.id)) {
    return null
  }

  return {
    schemaVersion: 1,
    activeProfileId: value.activeProfileId,
    profiles
  }
}

function defaultProfileState(): ProfileState {
  return {
    schemaVersion: 1,
    activeProfileId: DEFAULT_PROFILE.id,
    profiles: [{ ...DEFAULT_PROFILE }]
  }
}

function createProfileId(name: string): string {
  const slug =
    name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'profile'
  return `${slug}-${randomUUID().slice(0, 8)}`
}

function normalizeProfileName(name: string): string {
  const normalized = name.trim()
  if (normalized.length === 0 || normalized.length > 80) {
    throw new Error('Profile 名称必须是 1–80 个字符')
  }
  return normalized
}

function requireProfile(state: ProfileState, profileId: string): ProfileRecord {
  const profile = state.profiles.find((item) => item.id === profileId)
  if (!profile) {
    throw new Error(`Profile 不存在：${profileId}`)
  }
  return profile
}

function isProfileId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
