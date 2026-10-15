import type {
  CapabilityPolicy,
  CapabilitySettings,
  OriginCapabilityRule
} from '../shared/contracts'
import { readJsonFile, writeJsonAtomic } from './atomic-file'

export const DEFAULT_CAPABILITIES: CapabilitySettings = {
  popups: false,
  downloads: true,
  notifications: false,
  geolocation: false,
  media: false,
  clipboardRead: false,
  fullscreen: false
}

const CAPABILITY_KEYS = Object.keys(
  DEFAULT_CAPABILITIES
) as Array<keyof CapabilitySettings>

export class CapabilityStore {
  constructor(readonly filePath: string) {}

  async read(): Promise<CapabilityPolicy> {
    const value = await readJsonFile(this.filePath)
    const policy = parseCapabilityPolicy(value)
    if (policy) {
      return policy
    }

    const legacySettings = parseCapabilitySettings(value)
    return createCapabilityPolicy(legacySettings ?? DEFAULT_CAPABILITIES)
  }

  async write(value: unknown): Promise<CapabilityPolicy> {
    const policy = parseCapabilityPolicy(value)
    if (!policy) {
      throw new Error('Capability Policy 格式无效')
    }
    await writeJsonAtomic(this.filePath, policy)
    return policy
  }
}

export function createCapabilityPolicy(
  defaults: CapabilitySettings = DEFAULT_CAPABILITIES
): CapabilityPolicy {
  return {
    schemaVersion: 1,
    defaults: { ...defaults },
    origins: []
  }
}

export function parseCapabilityPolicy(
  value: unknown
): CapabilityPolicy | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'defaults', 'origins']) ||
    value.schemaVersion !== 1
  ) {
    return null
  }

  const defaults = parseCapabilitySettings(value.defaults)
  if (
    !defaults ||
    !Array.isArray(value.origins) ||
    value.origins.length > 256
  ) {
    return null
  }

  const origins: OriginCapabilityRule[] = []
  const seenOrigins = new Set<string>()
  for (const candidate of value.origins) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ['origin', 'overrides']) ||
      typeof candidate.origin !== 'string'
    ) {
      return null
    }
    const origin = normalizeCapabilityOrigin(candidate.origin)
    const overrides = parseCapabilityOverrides(candidate.overrides)
    if (
      !origin ||
      origin !== candidate.origin ||
      !overrides ||
      seenOrigins.has(origin)
    ) {
      return null
    }
    seenOrigins.add(origin)
    origins.push({ origin, overrides })
  }

  origins.sort((left, right) =>
    left.origin < right.origin ? -1 : left.origin > right.origin ? 1 : 0
  )
  return {
    schemaVersion: 1,
    defaults,
    origins
  }
}

export function parseCapabilitySettings(
  value: unknown
): CapabilitySettings | null {
  if (!isRecord(value)) {
    return null
  }

  const keys = Object.keys(value)
  if (
    keys.length !== CAPABILITY_KEYS.length ||
    !keys.every((key) => CAPABILITY_KEYS.includes(key as keyof CapabilitySettings)) ||
    !CAPABILITY_KEYS.every((key) => typeof value[key] === 'boolean')
  ) {
    return null
  }

  return Object.fromEntries(
    CAPABILITY_KEYS.map((key) => [key, value[key]])
  ) as unknown as CapabilitySettings
}

export function normalizeCapabilityOrigin(input: string): string | null {
  try {
    const url = new URL(input)
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return null
    }
    return url.origin
  } catch {
    return null
  }
}

export function resolveCapabilitySettings(
  policy: CapabilityPolicy,
  requestingUrlOrOrigin: string | null | undefined
): CapabilitySettings {
  const origin = requestingUrlOrOrigin
    ? normalizeCapabilityOrigin(requestingUrlOrOrigin)
    : null
  const rule = origin
    ? policy.origins.find((candidate) => candidate.origin === origin)
    : undefined
  return {
    ...policy.defaults,
    ...(rule?.overrides ?? {})
  }
}

export function cloneCapabilityPolicy(
  policy: CapabilityPolicy
): CapabilityPolicy {
  return {
    schemaVersion: 1,
    defaults: { ...policy.defaults },
    origins: policy.origins.map((rule) => ({
      origin: rule.origin,
      overrides: { ...rule.overrides }
    }))
  }
}

function parseCapabilityOverrides(
  value: unknown
): Partial<CapabilitySettings> | null {
  if (!isRecord(value)) {
    return null
  }

  const keys = Object.keys(value)
  if (
    keys.length === 0 ||
    !keys.every(
      (key) =>
        CAPABILITY_KEYS.includes(key as keyof CapabilitySettings) &&
        typeof value[key] === 'boolean'
    )
  ) {
    return null
  }

  return Object.fromEntries(
    keys.map((key) => [key, value[key]])
  ) as Partial<CapabilitySettings>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[]
): boolean {
  const keys = Object.keys(value)
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  )
}
