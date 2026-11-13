import { describe, expect, it } from 'vitest'

import type { UpdateOffer, UpdateStatus } from '../src/shared/contracts'
import { describeUpdateStatus } from '../src/renderer/src/update-view'

const base: UpdateStatus = {
  enabled: true,
  channel: 'dev',
  currentVersion: '0.1.0-dev.7+7',
  currentCode: 7,
  phase: 'idle',
  message: null,
  available: null,
  progress: null,
  manualUrl: null,
  checkedAt: null
}

const offer: UpdateOffer = {
  version: '0.2.0',
  code: 9,
  mandatory: false,
  inApp: true,
  fullInstall: false,
  releaseNotes: '',
  releaseNotesUrl: null,
  sizeBytes: 2048
}

function view(patch: Partial<UpdateStatus>) {
  return describeUpdateStatus({ ...base, ...patch })
}

describe('describeUpdateStatus', () => {
  it('shows a loading state before the first status', () => {
    expect(describeUpdateStatus(null)).toMatchObject({
      action: null,
      busy: true
    })
  })

  it('maps idle, disabled and checking', () => {
    expect(view({})).toMatchObject({
      action: 'check',
      detail: '当前 0.1.0-dev.7+7'
    })
    expect(
      view({ phase: 'disabled', enabled: false, message: '未接入' })
    ).toMatchObject({
      action: null,
      detail: '未接入'
    })
    expect(view({ phase: 'disabled' }).detail).toBe('当前 0.1.0-dev.7+7')
    expect(view({ phase: 'checking' })).toMatchObject({
      action: null,
      busy: true
    })
  })

  it('maps up to date with an optional message', () => {
    expect(view({ phase: 'up-to-date' })).toMatchObject({
      title: '已是最新',
      action: 'check'
    })
    expect(view({ phase: 'up-to-date', message: '已撤回' }).detail).toBe(
      '已撤回'
    )
  })

  it('offers download for in-app updates and the release page otherwise', () => {
    expect(view({ phase: 'available', available: offer })).toMatchObject({
      title: '发现新版本 0.2.0',
      action: 'download',
      actionLabel: '下载更新'
    })
    expect(
      view({ phase: 'available', available: { ...offer, sizeBytes: 0 } }).detail
    ).toBe('当前 0.1.0-dev.7+7')
    expect(
      view({
        phase: 'available',
        available: { ...offer, inApp: false },
        manualUrl: 'https://x'
      })
    ).toMatchObject({ action: 'open-manual' })
    expect(
      view({ phase: 'available', available: { ...offer, inApp: false } }).action
    ).toBeNull()
  })

  it('shows download progress', () => {
    expect(
      view({
        phase: 'downloading',
        available: offer,
        progress: { received: 512, total: 2048, bytesPerSecond: 1 }
      })
    ).toMatchObject({ title: '正在下载 0.2.0', detail: '25%', busy: true })
    expect(
      view({
        phase: 'downloading',
        progress: { received: 0, total: 0, bytesPerSecond: 0 }
      }).detail
    ).not.toContain('%')
    expect(view({ phase: 'downloading' }).detail).toBe('')
  })

  it('offers install once downloaded', () => {
    expect(view({ phase: 'downloaded', available: offer })).toMatchObject({
      title: '0.2.0 已就绪',
      detail: '重启后完成安装',
      action: 'install'
    })
    expect(
      view({ phase: 'downloaded', available: { ...offer, fullInstall: true } })
        .detail
    ).toContain('安装程序')
    expect(view({ phase: 'downloaded' }).title).toBe('新版本 已就绪')
  })

  it('maps applying and fallback', () => {
    expect(view({ phase: 'applying', message: 'm' })).toMatchObject({
      busy: true,
      detail: 'm'
    })
    expect(view({ phase: 'fallback', manualUrl: 'https://x' }).action).toBe(
      'open-manual'
    )
    expect(view({ phase: 'fallback' }).action).toBe('check')
  })

  it('retries the right step after an error', () => {
    expect(view({ phase: 'error', available: offer }).actionLabel).toBe(
      '重试下载'
    )
    expect(view({ phase: 'error' }).actionLabel).toBe('重新检查')
  })
})
