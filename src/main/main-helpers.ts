import type {
  JsonValue,
  ProfileSummary,
  ProjectDefinition,
  ProjectRuntimeSnapshot,
  StrategyDefinition
} from '../shared/contracts'
import type { ProfileState } from './profile-store'

/**
 * 主进程入口与冒烟宿主共用的小型纯函数。
 *
 * 这些函数只做数据整形与解析，不持有状态、不依赖 Electron 单例，
 * 因此可以从入口模块中独立出来并被单独测试。
 */

export function toProfileSummaries(state: ProfileState): ProfileSummary[] {
  return state.profiles.map((profile) => ({
    ...profile,
    active: profile.id === state.activeProfileId
  }))
}

export function cloneProjectDefinition(
  project: ProjectDefinition
): ProjectDefinition {
  return structuredClone(project)
}

export function cloneStrategyDefinitions(
  definitions: StrategyDefinition[]
): StrategyDefinition[] {
  return definitions.map((definition) => ({
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
  }))
}

export function parseDownloadIntentPayload(value: unknown): {
  businessItemId: string
  attachmentId: string
  sourceUrl: string
  originalFileName: string
  mime?: string
  expectedBytes: number | null
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  const allowedKeys = new Set([
    'businessItemId',
    'attachmentId',
    'sourceUrl',
    'fileName',
    'mime',
    'expectedBytes'
  ])
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    return null
  }
  const required = [
    record.businessItemId,
    record.attachmentId,
    record.sourceUrl,
    record.fileName
  ]
  if (
    required.some(
      (item) => typeof item !== 'string' || item.trim().length === 0
    ) ||
    (record.mime !== undefined &&
      (typeof record.mime !== 'string' || record.mime.trim().length === 0)) ||
    (record.expectedBytes !== undefined &&
      (!Number.isSafeInteger(record.expectedBytes) ||
        (record.expectedBytes as number) < 0))
  ) {
    return null
  }
  try {
    const sourceUrl = new URL(record.sourceUrl as string)
    if (sourceUrl.protocol !== 'http:' && sourceUrl.protocol !== 'https:') {
      return null
    }
    return {
      businessItemId: record.businessItemId as string,
      attachmentId: record.attachmentId as string,
      sourceUrl: sourceUrl.toString(),
      originalFileName: record.fileName as string,
      ...(typeof record.mime === 'string' ? { mime: record.mime } : {}),
      expectedBytes:
        record.expectedBytes === undefined
          ? null
          : (record.expectedBytes as number)
    }
  } catch {
    return null
  }
}

export function normalizeComparableUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    return url.toString()
  } catch {
    return value
  }
}

export function parseTakeoverReason(
  value: JsonValue | undefined,
  fallback: string
): string {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.reason === 'string' &&
    value.reason.trim().length > 0
  ) {
    return value.reason.trim().slice(0, 4_000)
  }
  return fallback
}

export function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isTerminalProjectRuntime(
  runtime: ProjectRuntimeSnapshot | null | undefined
): boolean {
  return (
    runtime !== null &&
    runtime !== undefined &&
    (runtime.status === 'completed' ||
      runtime.status === 'failed' ||
      runtime.status === 'cancelled')
  )
}

/**
 * 某个页面视图此刻是否应当可见。
 *
 * 原生 `WebContentsView` 的层位高于壳层的渲染层，渲染层的 z-index 无法盖住它。
 * 因此全屏覆盖层（设置页）打开时，必须由主进程把页面视图整体隐藏，
 * 否则内嵌网页会整片压在设置页之上。
 *
 * @param overlayVisible 覆盖层是否打开
 * @param selected 该视图是否是当前选中的那一个
 */
export function isPageViewVisible(
  overlayVisible: boolean,
  selected: boolean
): boolean {
  return !overlayVisible && selected
}
