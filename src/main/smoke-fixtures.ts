import type { StrategyDefinition, StrategyDraft } from '../shared/contracts'

/**
 * 冒烟测试使用的策略与项目 fixture。
 *
 * 这些定义以源码字符串形式内联策略脚本，只在 `--*-smoke-test` 入口下被装载，
 * 不参与正常启动路径。独立成模块后，主进程入口不再承载测试脚本内容。
 */

export function createStrategySmokeDefinitions(): StrategyDefinition[] {
  return [
    {
      manifest: {
        id: 'smoke-document-start',
        name: 'Smoke Document Start',
        version: '0.1.0',
        matches: ['<all_urls>'],
        excludes: [],
        runAt: 'document-start',
        frames: 'all',
        permissions: ['dom.write', 'log'],
        networkMatches: [],
        config: {},
        timeouts: {
          startupMs: 5_000,
          heartbeatMs: 2_000
        }
      },
      source: `
globalThis.__agenticStrategyPrivate = true
document.addEventListener(
  '__agentic-phase2-inline-probe',
  () => {
    document.documentElement.dataset.agenticStrategyStart =
      document.readyState
    document.documentElement.dataset.agenticStrategyNode =
      typeof globalThis.process === 'undefined' &&
      typeof globalThis.require === 'undefined'
        ? 'isolated'
        : 'exposed'
  },
  { once: true }
)
await agenticStrategy.log('document-start installed')
`,
      enabled: true,
      updatedAt: '2026-10-15T00:00:00.000Z'
    },
    {
      manifest: {
        id: 'smoke-idle-host-api',
        name: 'Smoke Idle Host API',
        version: '0.1.0',
        matches: ['<all_urls>'],
        excludes: [],
        runAt: 'document-idle',
        frames: 'top',
        permissions: [
          'dom.read',
          'dom.write',
          'config.read',
          'log',
          'project.emit-event',
          'network.request',
          'main-world'
        ],
        networkMatches: ['<all_urls>'],
        config: { expectedMarker: 'network-ok' },
        timeouts: {
          startupMs: 5_000,
          heartbeatMs: 2_000
        }
      },
      source: `
const response = await agenticStrategy.request({
  url: new URL('/strategy-data', location.href).toString()
})
const payload = JSON.parse(response.body)
if (payload.marker !== agenticStrategy.config.expectedMarker) {
  throw new Error('Strategy config/network marker 不匹配')
}
document.documentElement.dataset.agenticStrategyNode = payload.marker
await agenticStrategy.evaluateMainWorld(
  "globalThis.__agenticStrategyMainWorld = 'allowed'; 'allowed'"
)
await agenticStrategy.emit('smoke.strategy-ready', {
  marker: payload.marker
})
`,
      enabled: true,
      updatedAt: '2026-10-15T00:00:00.000Z'
    }
  ]
}

export function createStrategyFaultSmokeDefinition(): StrategyDefinition {
  return {
    manifest: {
      id: 'smoke-heartbeat-block',
      name: 'Smoke Heartbeat Block',
      version: '0.1.0',
      matches: ['<all_urls>'],
      excludes: [],
      runAt: 'document-idle',
      frames: 'top',
      permissions: ['dom.read'],
      networkMatches: [],
      config: {},
      timeouts: {
        startupMs: 5_000,
        heartbeatMs: 500
      }
    },
    source: `
globalThis.setTimeout(() => {
  while (true) {
    // 故障注入：阻塞 renderer，验证宿主心跳可强制终止。
  }
}, 250)
`,
    enabled: true,
    updatedAt: '2026-10-15T00:00:00.000Z'
  }
}

export function createProjectDownloadSmokeDefinition(): StrategyDefinition {
  return {
    manifest: {
      id: 'smoke-project-download',
      name: 'Smoke Project Download',
      version: '0.1.0',
      matches: ['<all_urls>'],
      excludes: [],
      runAt: 'document-idle',
      frames: 'top',
      permissions: ['dom.write', 'project.emit-event', 'log'],
      networkMatches: [],
      config: {},
      timeouts: {
        startupMs: 5_000,
        heartbeatMs: 2_000
      }
    },
    source: `
if (!new URL(location.href).searchParams.has('project-runtime-smoke')) {
  return
}
const noise = document.createElement('div')
noise.id = 'project-noise'
document.body.append(noise)
const blockedImage = document.createElement('img')
blockedImage.src = new URL('/blocked.png', location.href).toString()
document.body.append(blockedImage)
const sourceUrl = new URL('/sample.mp3', location.href).toString()
const reservation = await agenticStrategy.emit('download.intent', {
  businessItemId: 'post-42',
  attachmentId: 'audio-7',
  sourceUrl,
  fileName: 'meeting:sample?.mp3',
  mime: 'audio/mpeg',
  expectedBytes: 4096
})
document.documentElement.dataset.agenticDownloadIntent = reservation.kind
if (
  reservation.kind === 'reserved' ||
  (reservation.kind === 'in-progress' && reservation.canStart === true)
) {
  const link = document.createElement('a')
  link.href = sourceUrl
  link.download = 'meeting:sample?.mp3'
  document.body.append(link)
  link.click()
  link.remove()
} else if (reservation.kind === 'duplicate') {
  await new Promise((resolve) => setTimeout(resolve, 100))
  await agenticStrategy.emit('download.completed', {
    downloadId: reservation.downloadId,
    duplicate: true
  })
}
await agenticStrategy.log('project download intent', reservation)
`,
    enabled: true,
    updatedAt: '2026-10-15T00:00:00.000Z'
  }
}

export function createProjectConcurrencySmokeDefinition(): StrategyDefinition {
  return {
    manifest: {
      id: 'smoke-project-concurrency',
      name: 'Smoke Project Concurrency',
      version: '0.1.0',
      matches: ['<all_urls>'],
      excludes: [],
      runAt: 'document-idle',
      frames: 'top',
      permissions: ['dom.read', 'dom.write', 'project.emit-event', 'log'],
      networkMatches: [],
      config: {},
      timeouts: {
        startupMs: 5_000,
        heartbeatMs: 2_000
      }
    },
    source: `
const projectId = new URL(location.href).searchParams.get(
  'concurrency-project'
)
if (!projectId) {
  return
}
document.cookie =
  'agentic_runtime=' + encodeURIComponent(projectId) +
  '; Path=/; SameSite=Lax'
await agenticStrategy.emit('runtime.ready', {
  projectId,
  cookie: document.cookie,
  href: location.href
})
const sourceUrl = new URL('/sample.mp3', location.href).toString()
const reservation = await agenticStrategy.emit('download.intent', {
  businessItemId: projectId,
  attachmentId: 'audio-1',
  sourceUrl,
  fileName: projectId + '.mp3',
  mime: 'audio/mpeg',
  expectedBytes: 4096
})
if (
  reservation.kind === 'reserved' ||
  (reservation.kind === 'in-progress' && reservation.canStart === true)
) {
  const link = document.createElement('a')
  link.href = sourceUrl
  link.download = projectId + '.mp3'
  document.body.append(link)
  link.click()
  link.remove()
} else if (reservation.kind === 'duplicate') {
  await agenticStrategy.emit('download.completed', {
    downloadId: reservation.downloadId,
    duplicate: true
  })
}
await agenticStrategy.log('concurrency runtime ready', { projectId })
`,
    enabled: true,
    updatedAt: '2026-10-15T00:00:00.000Z'
  }
}

export function createProjectTakeoverSmokeDefinition(): StrategyDefinition {
  return {
    manifest: {
      id: 'smoke-project-takeover',
      name: 'Smoke Project Takeover',
      version: '0.1.0',
      matches: ['<all_urls>'],
      excludes: [],
      runAt: 'document-idle',
      frames: 'top',
      permissions: ['dom.write', 'project.emit-event', 'log'],
      networkMatches: [],
      config: {},
      timeouts: {
        startupMs: 5_000,
        heartbeatMs: 2_000
      }
    },
    source: `
const mode = new URL(location.href).searchParams.get('takeover')
document.documentElement.dataset.agenticTakeoverStrategy = mode || 'initial'
if (mode === 'manual-complete') {
  await agenticStrategy.emit('takeover.completed', {
    href: location.href
  })
}
await agenticStrategy.log('takeover strategy ready', { mode })
`,
    enabled: true,
    updatedAt: '2026-10-15T00:00:00.000Z'
  }
}

export function createStrategyWorkspaceSmokeDraft(
  version: string,
  marker: string
): StrategyDraft {
  return {
    manifest: {
      id: 'smoke-workspace-hot-reload',
      name: 'Smoke Workspace Hot Reload',
      version,
      matches: ['<all_urls>'],
      excludes: [],
      runAt: 'document-idle',
      frames: 'top',
      permissions: ['dom.write', 'log'],
      networkMatches: [],
      config: {},
      timeouts: {
        startupMs: 5_000,
        heartbeatMs: 2_000
      }
    },
    source: `
document.documentElement.dataset.agenticStrategyNode =
  ${JSON.stringify(marker)}
await agenticStrategy.log(${JSON.stringify(`workspace ${marker}`)})
`,
    enabled: true
  }
}
