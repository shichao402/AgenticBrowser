import { rename } from 'node:fs/promises'

import { normalizeNavigationUrl } from './navigation'
import { isNodeError, readJsonFile, writeJsonAtomic } from './atomic-file'

export const BROWSER_CHECKPOINT_SCHEMA_VERSION = 1

export interface BrowserCheckpoint {
  schemaVersion: typeof BROWSER_CHECKPOINT_SCHEMA_VERSION
  profileId: string
  url: string
  reason: string
  updatedAt: string
}

export interface SaveBrowserCheckpoint {
  profileId: string
  url: string
  reason: string
}

export class BrowserCheckpointStore {
  private writeQueue = Promise.resolve()

  constructor(readonly filePath: string) {}

  async read(): Promise<BrowserCheckpoint | null> {
    let value: unknown

    try {
      value = await readJsonFile(this.filePath)
    } catch (error) {
      if (error instanceof SyntaxError) {
        await this.quarantine()
        return null
      }
      throw error
    }

    if (value === null) {
      return null
    }

    const checkpoint = parseBrowserCheckpoint(value)
    if (!checkpoint) {
      await this.quarantine()
      return null
    }

    return checkpoint
  }

  async write(input: SaveBrowserCheckpoint): Promise<BrowserCheckpoint> {
    const checkpoint: BrowserCheckpoint = {
      schemaVersion: BROWSER_CHECKPOINT_SCHEMA_VERSION,
      profileId: normalizeProfileId(input.profileId),
      url: normalizeNavigationUrl(input.url),
      reason: normalizeReason(input.reason),
      updatedAt: new Date().toISOString()
    }

    const write = this.writeQueue.then(() =>
      writeJsonAtomic(this.filePath, checkpoint)
    )
    this.writeQueue = write.catch(() => undefined)
    await write
    return checkpoint
  }

  private async quarantine(): Promise<void> {
    const timestamp = new Date().toISOString().replaceAll(':', '-')
    try {
      await rename(this.filePath, `${this.filePath}.corrupt-${timestamp}`)
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) {
        throw error
      }
    }
  }
}

export function parseBrowserCheckpoint(
  value: unknown
): BrowserCheckpoint | null {
  if (!isRecord(value)) {
    return null
  }

  if (
    value.schemaVersion !== BROWSER_CHECKPOINT_SCHEMA_VERSION ||
    typeof value.profileId !== 'string' ||
    typeof value.url !== 'string' ||
    typeof value.reason !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    return null
  }

  let url: string
  try {
    url = normalizeNavigationUrl(value.url)
  } catch {
    return null
  }

  const profileId = safeNormalize(normalizeProfileId, value.profileId)
  const reason = safeNormalize(normalizeReason, value.reason)
  if (!profileId || !reason || Number.isNaN(Date.parse(value.updatedAt))) {
    return null
  }

  return {
    schemaVersion: BROWSER_CHECKPOINT_SCHEMA_VERSION,
    profileId,
    url,
    reason,
    updatedAt: value.updatedAt
  }
}

function normalizeProfileId(value: string): string {
  const normalized = value.trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error('Profile ID 必须是 1–64 位字母、数字、下划线或连字符')
  }
  return normalized
}

function normalizeReason(value: string): string {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > 128) {
    throw new Error('检查点原因必须是 1–128 个字符')
  }
  return normalized
}

function safeNormalize(
  normalize: (value: string) => string,
  value: string
): string | null {
  try {
    return normalize(value)
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
