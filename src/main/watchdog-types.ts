/**
 * Watchdog 的共享类型。
 *
 * 单独成文件，让校验逻辑（`watchdog-config.ts`）与守护脚本（`watchdog.ts`）
 * 都能引用，而不必让测试去 import 那个一加载就启动子进程的脚本。
 */

export interface WatchdogConfig {
  schemaVersion: 1
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  heartbeatPath: string
  statePath: string
  lockPath?: string
  maxRestarts: number
  startupGraceMs: number
  heartbeatTimeoutMs: number
  heartbeatPollMs: number
  restartBackoffMs: number
}

export interface WatchdogState {
  schemaVersion: 1
  phase: 'starting' | 'running' | 'backoff' | 'stopped' | 'failed'
  watchdogPid: number
  childPid: number | null
  restartCount: number
  launches: number
  timestamp: string
  detail?: string
  lastExit?: {
    code: number | null
    signal: NodeJS.Signals | null
    heartbeatTimedOut: boolean
  }
  restartHistory?: Array<{
    restartCount: number
    code: number | null
    signal: NodeJS.Signals | null
    heartbeatTimedOut: boolean
    timestamp: string
  }>
}
