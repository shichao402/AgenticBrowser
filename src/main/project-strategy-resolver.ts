import type {
  ProjectDefinition,
  ProjectStrategyResolution,
  StrategyDefinition
} from '../shared/contracts'

export interface ResolvedProjectStrategies {
  definitions: StrategyDefinition[]
  allowedStrategyIds: ReadonlySet<string>
  resolutions: ProjectStrategyResolution[]
}

export function resolveProjectStrategies(
  project: ProjectDefinition,
  registry: StrategyDefinition[]
): ResolvedProjectStrategies {
  const byId = new Map(
    registry.map((definition) => [definition.manifest.id, definition])
  )
  const definitions: StrategyDefinition[] = []
  const allowedStrategyIds = new Set<string>()
  const resolutions = [...project.strategies]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map<ProjectStrategyResolution>(
      ({ id: strategyId, version: pinnedVersion }) => {
        const definition = byId.get(strategyId)
        if (!definition) {
          return {
            strategyId,
            pinnedVersion,
            registryVersion: null,
            status: 'missing',
            runnable: false
          }
        }
        if (definition.manifest.version !== pinnedVersion) {
          return {
            strategyId,
            pinnedVersion,
            registryVersion: definition.manifest.version,
            status: 'version-mismatch',
            runnable: false
          }
        }
        if (!definition.enabled) {
          return {
            strategyId,
            pinnedVersion,
            registryVersion: definition.manifest.version,
            status: 'disabled',
            runnable: false
          }
        }

        definitions.push(cloneDefinition(definition))
        allowedStrategyIds.add(strategyId)
        return {
          strategyId,
          pinnedVersion,
          registryVersion: definition.manifest.version,
          status: 'ready',
          runnable: true
        }
      }
    )

  return {
    definitions,
    allowedStrategyIds,
    resolutions
  }
}

export function requireRunnableProjectStrategies(
  resolved: ResolvedProjectStrategies
): void {
  const failures = resolved.resolutions.filter(
    (resolution) => !resolution.runnable
  )
  if (failures.length === 0) {
    return
  }
  const detail = failures
    .map((failure) => {
      switch (failure.status) {
        case 'missing':
          return `${failure.strategyId}@${failure.pinnedVersion} 不存在`
        case 'version-mismatch':
          return `${failure.strategyId} 需要 ${failure.pinnedVersion}，注册表为 ${failure.registryVersion}`
        case 'disabled':
          return `${failure.strategyId}@${failure.pinnedVersion} 已禁用`
        case 'ready':
          return `${failure.strategyId}@${failure.pinnedVersion} 状态异常`
      }
    })
    .join('；')
  throw new Error(`Project Strategy 固定版本不可运行：${detail}`)
}

function cloneDefinition(definition: StrategyDefinition): StrategyDefinition {
  return {
    ...definition,
    manifest: {
      ...definition.manifest,
      matches: [...definition.manifest.matches],
      excludes: [...definition.manifest.excludes],
      permissions: [...definition.manifest.permissions],
      networkMatches: [...definition.manifest.networkMatches],
      config: structuredClone(definition.manifest.config),
      timeouts: { ...definition.manifest.timeouts }
    }
  }
}
