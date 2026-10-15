import type { CapabilitySettings } from '../shared/contracts'
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

  async read(): Promise<CapabilitySettings> {
    const value = await readJsonFile(this.filePath)
    return parseCapabilitySettings(value) ?? { ...DEFAULT_CAPABILITIES }
  }

  async write(value: unknown): Promise<CapabilitySettings> {
    const settings = parseCapabilitySettings(value)
    if (!settings) {
      throw new Error('Capability 配置格式无效')
    }
    await writeJsonAtomic(this.filePath, settings)
    return settings
  }
}

export function parseCapabilitySettings(
  value: unknown
): CapabilitySettings | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }

  const record = value as Record<string, unknown>
  if (!CAPABILITY_KEYS.every((key) => typeof record[key] === 'boolean')) {
    return null
  }

  return Object.fromEntries(
    CAPABILITY_KEYS.map((key) => [key, record[key]])
  ) as unknown as CapabilitySettings
}
