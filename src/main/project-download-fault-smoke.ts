import type { ProjectDraft, StrategyDraft } from '../shared/contracts'
import { createCapabilityPolicy } from './capability-store'

export type ProjectDownloadFaultKind = 'network' | 'disk'

export const PROJECT_DOWNLOAD_FAULT_VERSION = '0.1.0'
export const PROJECT_DOWNLOAD_NETWORK_PROJECT_ID =
  'smoke-project-download-network'
export const PROJECT_DOWNLOAD_NETWORK_STRATEGY_ID =
  'smoke-project-download-network'
export const PROJECT_DOWNLOAD_DISK_PROJECT_ID =
  'smoke-project-download-disk'
export const PROJECT_DOWNLOAD_DISK_STRATEGY_ID =
  'smoke-project-download-disk'

export interface ProjectDownloadFaultSmokeOptions {
  profileId: string
  pageUrl: string
  outputRoot: string
  expectedBytes: number
}

export function createProjectDownloadFaultStrategyDraft(
  kind: ProjectDownloadFaultKind,
  pageUrl: string,
  expectedBytes: number
): StrategyDraft {
  const page = requireHttpUrl(pageUrl)
  requirePositiveBytes(expectedBytes)
  const ids = faultIds(kind)
  const sourceUrl = new URL(
    kind === 'network' ? '/slow-network.mp3' : '/disk-sample.mp3',
    page
  ).toString()

  return {
    manifest: {
      id: ids.strategyId,
      name: `Smoke Project Download ${kind}`,
      version: PROJECT_DOWNLOAD_FAULT_VERSION,
      matches: [`${page.origin}/*`],
      excludes: [],
      runAt: 'document-idle',
      frames: 'top',
      permissions: ['dom.write', 'project.emit-event', 'log'],
      networkMatches: [],
      config: {},
      timeouts: {
        startupMs: 15_000,
        heartbeatMs: 30_000
      }
    },
    source: String.raw`
if (location.href !== ${JSON.stringify(page.toString())}) {
  return
}
const sourceUrl = ${JSON.stringify(sourceUrl)}
const reservation = await agenticStrategy.emit('download.intent', {
  businessItemId: ${JSON.stringify(`${kind}-download`)},
  attachmentId: ${JSON.stringify(`${kind}-sample.mp3`)},
  sourceUrl,
  fileName: ${JSON.stringify(`${kind}-sample.mp3`)},
  mime: 'audio/mpeg',
  expectedBytes: ${expectedBytes}
})
document.documentElement.dataset.agenticDownloadIntent = reservation.kind
if (
  reservation.kind === 'reserved' ||
  (reservation.kind === 'in-progress' && reservation.canStart === true)
) {
  const link = document.createElement('a')
  link.href = sourceUrl
  link.download = ${JSON.stringify(`${kind}-sample.mp3`)}
  link.hidden = true
  document.body.append(link)
  link.click()
  link.remove()
}
await agenticStrategy.log('project download ${kind} intent', reservation)
`,
    enabled: true
  }
}

export function createProjectDownloadFaultProjectDraft(
  kind: ProjectDownloadFaultKind,
  options: ProjectDownloadFaultSmokeOptions
): ProjectDraft {
  const page = requireHttpUrl(options.pageUrl)
  requirePositiveBytes(options.expectedBytes)
  const ids = faultIds(kind)

  return {
    id: ids.projectId,
    name: `Smoke Project Download ${kind}`,
    profileId: options.profileId,
    startupPages: [page.toString()],
    strategies: [
      {
        id: ids.strategyId,
        version: PROJECT_DOWNLOAD_FAULT_VERSION
      }
    ],
    runtime: {
      mode: 'manual',
      timezone: 'Asia/Shanghai',
      priority: 10,
      maxRunMs: 45_000
    },
    workflow: {
      version: 1,
      entryNodeId: 'open-download-page',
      nodes: [
        {
          id: 'open-download-page',
          kind: 'navigate',
          url: page.toString(),
          next: 'wait-download-failed',
          timeoutMs: 20_000,
          maxAttempts: 1,
          checkpoint: true
        },
        {
          id: 'wait-download-failed',
          kind: 'wait-for-event',
          eventName: 'download.failed',
          next: 'finished',
          timeoutMs: 30_000,
          maxAttempts: 1,
          checkpoint: true
        },
        {
          id: 'finished',
          kind: 'complete',
          timeoutMs: 1_000,
          maxAttempts: 1,
          checkpoint: true
        }
      ]
    },
    output: {
      root: options.outputRoot,
      maxBytes:
        kind === 'disk'
          ? 1024 * 1024
          : Math.max(options.expectedBytes * 4, 10 * 1024 * 1024),
      fileNameTemplate: '{postId}-{fileName}'
    },
    capabilities: createCapabilityPolicy(),
    filter: {
      enabled: false,
      networkRules: [],
      cssRules: []
    },
    retry: {
      maxConsecutiveFailures: 2,
      baseBackoffMs: 250,
      maxBackoffMs: 1_000
    },
    enabled: true
  }
}

function faultIds(kind: ProjectDownloadFaultKind): {
  projectId: string
  strategyId: string
} {
  return kind === 'network'
    ? {
        projectId: PROJECT_DOWNLOAD_NETWORK_PROJECT_ID,
        strategyId: PROJECT_DOWNLOAD_NETWORK_STRATEGY_ID
      }
    : {
        projectId: PROJECT_DOWNLOAD_DISK_PROJECT_ID,
        strategyId: PROJECT_DOWNLOAD_DISK_STRATEGY_ID
      }
}

function requirePositiveBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('下载故障 smoke 的预期字节数无效')
  }
}

function requireHttpUrl(value: string): URL {
  const url = new URL(value)
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password
  ) {
    throw new Error('下载故障 smoke 只接受无凭据 HTTP(S) URL')
  }
  return url
}
