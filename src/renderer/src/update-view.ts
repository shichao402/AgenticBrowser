import type { UpdateStatus } from '../../shared/contracts'
import { formatBytes } from './app-format'

// 更新状态到界面文案与可用动作的映射。纯函数，便于测试。

export type UpdateAction =
  'check' | 'download' | 'install' | 'open-manual' | null

export interface UpdateView {
  title: string
  detail: string
  action: UpdateAction
  actionLabel: string
  busy: boolean
}

function percent(received: number, total: number): string {
  if (total <= 0) return formatBytes(received)
  return `${Math.min(100, Math.floor((received / total) * 100))}%`
}

export function describeUpdateStatus(status: UpdateStatus | null): UpdateView {
  if (!status) {
    return {
      title: '更新',
      detail: '读取中…',
      action: null,
      actionLabel: '',
      busy: true
    }
  }
  const version = `当前 ${status.currentVersion}`
  const message = status.message ?? ''
  const offer = status.available
  switch (status.phase) {
    case 'disabled':
      return {
        title: '更新',
        detail: message || version,
        action: null,
        actionLabel: '',
        busy: false
      }
    case 'checking':
      return {
        title: '正在检查更新',
        detail: version,
        action: null,
        actionLabel: '',
        busy: true
      }
    case 'up-to-date':
      return {
        title: '已是最新',
        detail: message || version,
        action: 'check',
        actionLabel: '检查更新',
        busy: false
      }
    case 'available':
      if (offer && !offer.inApp) {
        return {
          title: `发现新版本 ${offer.version}`,
          detail: message,
          action: status.manualUrl ? 'open-manual' : null,
          actionLabel: '打开发布页',
          busy: false
        }
      }
      return {
        title: `发现新版本 ${offer?.version ?? ''}`.trim(),
        detail:
          offer && offer.sizeBytes > 0
            ? `大小 ${formatBytes(offer.sizeBytes)}`
            : version,
        action: 'download',
        actionLabel: '下载更新',
        busy: false
      }
    case 'downloading': {
      const progress = status.progress
      return {
        title: `正在下载 ${offer?.version ?? ''}`.trim(),
        detail: progress ? percent(progress.received, progress.total) : '',
        action: null,
        actionLabel: '',
        busy: true
      }
    }
    case 'downloaded':
      return {
        title: `${offer?.version ?? '新版本'} 已就绪`,
        detail: offer?.fullInstall
          ? '应用将退出并运行安装程序完成更新'
          : '重启后完成安装',
        action: 'install',
        actionLabel: '重启并安装',
        busy: false
      }
    case 'applying':
      return {
        title: '正在安装',
        detail: message,
        action: null,
        actionLabel: '',
        busy: true
      }
    case 'fallback':
      return {
        title: '需要手动更新',
        detail: message,
        action: status.manualUrl ? 'open-manual' : 'check',
        actionLabel: status.manualUrl ? '打开发布页' : '检查更新',
        busy: false
      }
    case 'error':
      if (offer?.inApp) {
        return {
          title: '更新失败',
          detail: message,
          action: 'download',
          actionLabel: '重试下载',
          busy: false
        }
      }
      return {
        title: '更新失败',
        detail: message,
        action: 'check',
        actionLabel: '重新检查',
        busy: false
      }
    case 'idle':
    default:
      return {
        title: '更新',
        detail: version,
        action: 'check',
        actionLabel: '检查更新',
        busy: false
      }
  }
}
