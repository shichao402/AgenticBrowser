import type { ProjectDraft, StrategyDraft } from '../shared/contracts'
import { createCapabilityPolicy } from './capability-store'

export const PROJECT_DOWNLOAD_RECOVERY_PROJECT_ID =
  'smoke-project-download-recovery'
export const PROJECT_DOWNLOAD_RECOVERY_STRATEGY_ID =
  'smoke-project-download-recovery'
export const PROJECT_DOWNLOAD_RECOVERY_STRATEGY_VERSION = '0.1.0'

export interface ProjectDownloadRecoverySmokeOptions {
  profileId: string
  pageUrl: string
  outputRoot: string
  expectedBytes: number
}

export function createProjectDownloadRecoveryStrategyDraft(
  pageUrl: string,
  expectedBytes: number
): StrategyDraft {
  const page = requireHttpUrl(pageUrl)
  const sourceUrl = new URL('/slow-sample.mp3', page).toString()
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
    throw new Error('下载恢复 smoke 的预期字节数无效')
  }

  return {
    manifest: {
      id: PROJECT_DOWNLOAD_RECOVERY_STRATEGY_ID,
      name: 'Smoke Project Download Recovery',
      version: PROJECT_DOWNLOAD_RECOVERY_STRATEGY_VERSION,
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
  businessItemId: 'recovery-download',
  attachmentId: 'slow-sample.mp3',
  sourceUrl,
  fileName: 'recovery-sample.mp3',
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
  link.download = 'recovery-sample.mp3'
  link.hidden = true
  document.body.append(link)
  link.click()
  link.remove()
} else if (reservation.kind === 'duplicate') {
  await agenticStrategy.emit('download.completed', {
    downloadId: reservation.downloadId,
    duplicate: true
  })
}
await agenticStrategy.log('project download recovery intent', reservation)
`,
    enabled: true
  }
}

export function createProjectDownloadRecoveryProjectDraft(
  options: ProjectDownloadRecoverySmokeOptions
): ProjectDraft {
  const page = requireHttpUrl(options.pageUrl)
  if (
    !Number.isSafeInteger(options.expectedBytes) ||
    options.expectedBytes <= 0
  ) {
    throw new Error('下载恢复 smoke 的预期字节数无效')
  }

  return {
    id: PROJECT_DOWNLOAD_RECOVERY_PROJECT_ID,
    name: 'Smoke Project Download Recovery',
    profileId: options.profileId,
    startupPages: [page.toString()],
    strategies: [
      {
        id: PROJECT_DOWNLOAD_RECOVERY_STRATEGY_ID,
        version: PROJECT_DOWNLOAD_RECOVERY_STRATEGY_VERSION
      }
    ],
    runtime: {
      mode: 'manual',
      timezone: 'Asia/Shanghai',
      priority: 10,
      maxRunMs: 90_000
    },
    workflow: {
      version: 1,
      entryNodeId: 'open-download-page',
      nodes: [
        {
          id: 'open-download-page',
          kind: 'navigate',
          url: page.toString(),
          next: 'wait-download',
          timeoutMs: 30_000,
          maxAttempts: 2,
          checkpoint: true
        },
        {
          id: 'wait-download',
          kind: 'wait-for-event',
          eventName: 'download.completed',
          next: 'finished',
          timeoutMs: 60_000,
          maxAttempts: 2,
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
      maxBytes: Math.max(options.expectedBytes * 4, 10 * 1024 * 1024),
      fileNameTemplate: '{postId}-{fileName}'
    },
    capabilities: createCapabilityPolicy(),
    filter: {
      enabled: false,
      networkRules: [],
      cssRules: []
    },
    retry: {
      maxConsecutiveFailures: 3,
      baseBackoffMs: 250,
      maxBackoffMs: 2_000
    },
    enabled: true
  }
}

function requireHttpUrl(value: string): URL {
  const url = new URL(value)
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password
  ) {
    throw new Error('下载恢复 smoke 只接受无凭据 HTTP(S) URL')
  }
  return url
}
