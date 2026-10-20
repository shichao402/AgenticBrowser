import type {
  BrowserEvent,
  CapabilityPolicySnapshot,
  CapabilitySettings,
  ProjectDefinition,
  ProjectDraft,
  ProjectRuntimeRecord,
  StrategyManifest
} from '../../shared/contracts'

/**
 * 渲染层展示用的常量与小工具。
 *
 * 这些内容原本内联在 `App.tsx`，与组件状态无关，抽出来后组件文件只保留
 * 交互编排与 JSX，也让纯函数可以被单独验证。
 */

export const EVENT_LABELS: Record<BrowserEvent['type'], string> = {
  created: '页面已创建',
  'navigation-started': '开始导航',
  'navigation-finished': '导航完成',
  'load-started': '开始加载',
  'load-finished': '加载完成',
  'load-failed': '加载失败',
  unresponsive: '页面无响应',
  responsive: '页面恢复响应',
  'renderer-gone': 'Renderer 已退出',
  recreated: '页面已重建',
  'checkpoint-saved': '检查点已保存',
  'checkpoint-failed': '检查点保存失败',
  'health-changed': '健康状态变化',
  'recovery-scheduled': '恢复已排队',
  'recovery-started': '开始恢复',
  'recovery-succeeded': '恢复成功',
  'circuit-open': '恢复熔断',
  'popup-blocked': '弹窗已拦截',
  'popup-routed': '弹窗已转入当前页',
  'download-blocked': '下载已拦截',
  'download-started': '下载开始',
  'download-progress': '下载进度',
  'download-completed': '下载完成',
  'download-failed': '下载失败',
  'strategy-started': '策略开始',
  'strategy-ready': '策略就绪',
  'strategy-log': '策略日志',
  'strategy-event': '策略领域事件',
  'strategy-failed': '策略失败',
  'strategy-heartbeat-missed': '策略心跳超时',
  'strategy-quarantined': '策略已隔离',
  'strategy-reloaded': '策略已重载',
  'project-runtime-started': '项目运行已启动',
  'project-runtime-paused': '项目已暂停并进入人工接管',
  'project-runtime-resumed': '项目自动化已恢复',
  'project-runtime-stopped': '项目运行已停止',
  'project-runtime-failed': '项目运行失败',
  'filter-hit': '过滤规则命中',
  'filter-css-applied': '页面隐藏规则已应用'
}

export const CAPABILITY_ITEMS: Array<{
  key: keyof CapabilitySettings
  label: string
}> = [
  { key: 'downloads', label: '下载' },
  { key: 'popups', label: '弹窗转入当前页' },
  { key: 'notifications', label: '通知' },
  { key: 'geolocation', label: '定位' },
  { key: 'media', label: '摄像头/麦克风' },
  { key: 'clipboardRead', label: '读取剪贴板' },
  { key: 'fullscreen', label: '全屏' }
]

export function formatBytes(value: number | undefined): string {
  if (value === undefined) {
    return '—'
  }
  return `${(value / (1024 * 1024)).toFixed(0)} MiB`
}

export function formatTime(value: string | null | undefined): string {
  if (!value) {
    return '—'
  }
  return new Date(value).toLocaleTimeString()
}

export function getOriginDecision(
  snapshot: CapabilityPolicySnapshot | null,
  key: keyof CapabilitySettings
): 'inherit' | 'allow' | 'deny' {
  if (!snapshot?.currentOrigin) {
    return 'inherit'
  }
  const rule = snapshot.policy.origins.find(
    (candidate) => candidate.origin === snapshot.currentOrigin
  )
  const value = rule?.overrides[key]
  return value === undefined ? 'inherit' : value ? 'allow' : 'deny'
}

export function isActiveProjectRuntime(runtime: ProjectRuntimeRecord): boolean {
  return (
    runtime.status !== 'completed' &&
    runtime.status !== 'failed' &&
    runtime.status !== 'cancelled'
  )
}

export function toProjectDraft(project: ProjectDefinition): ProjectDraft {
  const {
    revision: _revision,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...draft
  } = project
  return structuredClone(draft)
}

export function createDefaultProjectDraft(profileId: string): ProjectDraft {
  const outputRoot =
    typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')
      ? 'C:\\AgenticBrowser\\projects\\new-project'
      : '/Users/Shared/AgenticBrowser/projects/new-project'
  return {
    id: 'new-project',
    name: 'New Project',
    profileId,
    startupPages: ['https://example.com/'],
    strategies: [],
    runtime: {
      mode: 'manual',
      timezone: 'Asia/Shanghai',
      priority: 0,
      maxRunMs: 3_600_000
    },
    workflow: {
      version: 1,
      entryNodeId: 'open-home',
      nodes: [
        {
          id: 'open-home',
          kind: 'navigate',
          url: 'https://example.com/',
          next: 'wait-complete',
          timeoutMs: 30_000,
          maxAttempts: 3,
          checkpoint: true
        },
        {
          id: 'wait-complete',
          kind: 'wait-for-event',
          eventName: 'project.complete',
          next: 'finished',
          timeoutMs: 600_000,
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
      root: outputRoot,
      maxBytes: 10 * 1024 * 1024 * 1024,
      fileNameTemplate: '{postId}-{fileName}'
    },
    capabilities: {
      schemaVersion: 1,
      defaults: {
        popups: false,
        downloads: true,
        notifications: false,
        geolocation: false,
        media: false,
        clipboardRead: false,
        fullscreen: false
      },
      origins: []
    },
    filter: {
      enabled: false,
      networkRules: [],
      cssRules: []
    },
    retry: {
      maxConsecutiveFailures: 5,
      baseBackoffMs: 1_000,
      maxBackoffMs: 60_000
    },
    enabled: true
  }
}

export function createDefaultStrategyManifest(): StrategyManifest {
  return {
    id: 'new-strategy',
    name: 'New Strategy',
    version: '0.1.0',
    matches: ['https://example.com/*'],
    excludes: [],
    runAt: 'document-idle',
    frames: 'top',
    permissions: ['dom.read', 'log'],
    networkMatches: [],
    config: {},
    timeouts: {
      startupMs: 10_000,
      heartbeatMs: 30_000
    }
  }
}
