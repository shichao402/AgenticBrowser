import { randomUUID } from 'node:crypto'
import { rename } from 'node:fs/promises'

import { isNodeError, readJsonFile, writeJsonAtomic } from './atomic-file'

export interface StrategyPolicyState {
  schemaVersion: 1
  developmentAllowedStrategyIds: string[]
}

export class StrategyPolicyStore {
  private queue = Promise.resolve()

  constructor(readonly filePath: string) {}

  async read(): Promise<StrategyPolicyState> {
    let value: unknown | null
    try {
      value = await readJsonFile(this.filePath)
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error
      }
      await this.quarantineInvalidFile()
      return emptyStrategyPolicy()
    }

    if (value === null) {
      return emptyStrategyPolicy()
    }
    const policy = parseStrategyPolicy(value)
    if (policy) {
      return policy
    }
    await this.quarantineInvalidFile()
    return emptyStrategyPolicy()
  }

  async setAllowed(
    strategyId: string,
    allowed: boolean
  ): Promise<StrategyPolicyState> {
    requireStrategyId(strategyId)
    return this.update((policy) => {
      const ids = new Set(policy.developmentAllowedStrategyIds)
      if (allowed) {
        ids.add(strategyId)
      } else {
        ids.delete(strategyId)
      }
      return {
        schemaVersion: 1,
        developmentAllowedStrategyIds: [...ids].sort()
      }
    })
  }

  async remove(strategyId: string): Promise<StrategyPolicyState> {
    requireStrategyId(strategyId)
    return this.update((policy) => ({
      schemaVersion: 1,
      developmentAllowedStrategyIds:
        policy.developmentAllowedStrategyIds.filter(
          (candidate) => candidate !== strategyId
        )
    }))
  }

  private async update(
    transform: (policy: StrategyPolicyState) => StrategyPolicyState
  ): Promise<StrategyPolicyState> {
    let result: StrategyPolicyState | null = null
    const operation = this.queue.then(async () => {
      result = transform(await this.read())
      await writeJsonAtomic(this.filePath, result)
    })
    this.queue = operation.catch(() => undefined)
    await operation
    return result!
  }

  private async quarantineInvalidFile(): Promise<void> {
    const quarantinePath = `${this.filePath}.invalid-${Date.now()}-${randomUUID()}`
    await rename(this.filePath, quarantinePath).catch((error: unknown) => {
      if (!isNodeError(error, 'ENOENT')) {
        throw error
      }
    })
  }
}

export function emptyStrategyPolicy(): StrategyPolicyState {
  return {
    schemaVersion: 1,
    developmentAllowedStrategyIds: []
  }
}

export function parseStrategyPolicy(
  value: unknown
): StrategyPolicyState | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.developmentAllowedStrategyIds) ||
    value.developmentAllowedStrategyIds.length > 256 ||
    !value.developmentAllowedStrategyIds.every(
      (entry) =>
        typeof entry === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(entry)
    ) ||
    new Set(value.developmentAllowedStrategyIds).size !==
      value.developmentAllowedStrategyIds.length
  ) {
    return null
  }

  return {
    schemaVersion: 1,
    developmentAllowedStrategyIds: [
      ...value.developmentAllowedStrategyIds
    ].sort() as string[]
  }
}

function requireStrategyId(strategyId: string): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(strategyId)) {
    throw new Error('Strategy ID 格式无效')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
