import { app } from 'electron'
import type { BaseWindow, WebContentsView } from 'electron'

import type { BrowserEvent, StartupSettings } from '../shared/contracts'
import type { BrowserTabManager } from './browser-tab-manager'
import { MainProcessHeartbeat } from './main-process-heartbeat'
import { WATCHDOG_AUTOSTART_ARGUMENT } from './watchdog-launcher'

/**
 * 冒烟宿主的运行时上下文。
 *
 * 这些冒烟场景共用少量进程级状态（探测服务器、下载目录、watchdog 计数与心跳）。
 * 把它们集中在这一模块，避免冒烟实现与主进程入口互相 import 造成循环依赖，
 * 也让入口只保留真正的启动编排逻辑。
 */

export interface MainWindowRuntime {
  window: BaseWindow
  shellView: WebContentsView
  supervisor: BrowserTabManager
  events: BrowserEvent[]
  getEventCount(): number
  suppressShellEvents(): void
  prepareForShutdown(): Promise<void>
}

/**
 * watchdog 守护链在本次进程内的重启代数。
 *
 * 由启动参数解析得到，冒烟子进程据此判断自己是否处于被守护重启后的运行态。
 */
export const watchdogRestartCount = parseNonNegativeInteger(
  process.env.AGENTIC_WATCHDOG_RESTART_COUNT
)

/**
 * 主进程心跳。未启用 watchdog 时为 null。
 */
let mainProcessHeartbeat: MainProcessHeartbeat | null = null

export function initMainProcessHeartbeat(): void {
  const heartbeatPath = process.env.AGENTIC_WATCHDOG_HEARTBEAT_PATH
  if (!heartbeatPath) {
    return
  }
  mainProcessHeartbeat = new MainProcessHeartbeat(
    heartbeatPath,
    process.env.AGENTIC_WATCHDOG_LAUNCH_ID ?? `unmanaged-${process.pid}`,
    watchdogRestartCount
  )
}

export function getMainProcessHeartbeat(): MainProcessHeartbeat | null {
  return mainProcessHeartbeat
}

/**
 * 读取开机启动状态。
 *
 * 只有打包后的 Windows/macOS 应用支持；watchdog 托管状态由启动时注入的
 * 环境变量决定。
 */
export function getStartupSettings(): StartupSettings {
  const supported =
    app.isPackaged &&
    (process.platform === 'win32' || process.platform === 'darwin')
  let openAtLogin = false
  if (supported) {
    openAtLogin =
      process.platform === 'win32'
        ? app.getLoginItemSettings({
            path: process.execPath,
            args: [WATCHDOG_AUTOSTART_ARGUMENT]
          }).openAtLogin
        : app.getLoginItemSettings().openAtLogin
  }

  return {
    supported,
    openAtLogin,
    managedByWatchdog: process.env.AGENTIC_WATCHDOG_MANAGED === '1'
  }
}

export function parseNonNegativeInteger(value: string | undefined): number {
  if (!value) {
    return 0
  }

  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
}

export function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} 必须是正整数`)
  }
  return parsed
}

export function requireEnvironmentValue(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`缺少环境变量 ${name}`)
  }
  return value
}

export async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number
): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`等待条件超过 ${timeoutMs} ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

export async function closeSmokeRuntime(
  runtime: MainWindowRuntime
): Promise<void> {
  runtime.suppressShellEvents()
  await runtime.prepareForShutdown()
  runtime.window.close()
  await new Promise((resolve) => setTimeout(resolve, 250))
}
