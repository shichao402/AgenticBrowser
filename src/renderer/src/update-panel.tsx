import { useEffect, useState } from 'react'

import type { UpdateStatus } from '../../shared/contracts'
import { describeUpdateStatus } from './update-view'

// 侧栏里的“更新”一行。状态以主进程为准：首次拉取，之后靠推送。

export function UpdatePanel(): React.JSX.Element {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    window.agenticBrowser
      .getUpdateStatus()
      .then((next) => {
        if (!disposed) setStatus(next)
      })
      .catch((cause: unknown) => {
        if (!disposed)
          setFailure(cause instanceof Error ? cause.message : String(cause))
      })
    const unsubscribe = window.agenticBrowser.onUpdateStatus((next) => {
      setStatus(next)
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  const view = describeUpdateStatus(status)

  const runAction = async (): Promise<void> => {
    setFailure(null)
    try {
      switch (view.action) {
        case 'check':
          setStatus(await window.agenticBrowser.checkForUpdates())
          return
        case 'download':
          setStatus(await window.agenticBrowser.downloadUpdate())
          return
        case 'install':
          setStatus(await window.agenticBrowser.installUpdate())
          return
        case 'open-manual':
          if (status?.manualUrl) {
            await window.agenticBrowser.createTab(status.manualUrl)
          }
          return
        default:
          return
      }
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div className="update-setting">
      <span>
        {view.title}
        <small>{failure ?? view.detail}</small>
      </span>
      {view.action ? (
        <button
          type="button"
          disabled={view.busy}
          onClick={() => void runAction()}
        >
          {view.actionLabel}
        </button>
      ) : null}
    </div>
  )
}
