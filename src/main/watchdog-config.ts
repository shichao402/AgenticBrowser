import type { WatchdogConfig } from './watchdog-types'

/**
 * Watchdog 启动配置的校验。
 *
 * 从 `watchdog.ts` 抽出：那个文件底部直接 `void main()`，一 import 就会真的
 * 去守护子进程，无法被测试引用。这里只保留纯校验，既能让 `watchdog.ts`
 * 继续复用，也能独立验证每一条边界。
 *
 * 校验刻意从严：这些数值直接决定「多久判定卡死」与「最多重启几次」，
 * 一个越界值会让守护逻辑要么形同虚设，要么无限重启。
 */

export function parseWatchdogConfig(value: unknown): WatchdogConfig {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('Watchdog 配置版本无效')
  }

  const command = requireString(value.command, 'command')
  const cwd = requireString(value.cwd, 'cwd')
  const heartbeatPath = requireString(value.heartbeatPath, 'heartbeatPath')
  const statePath = requireString(value.statePath, 'statePath')
  const lockPath =
    value.lockPath === undefined
      ? undefined
      : requireString(value.lockPath, 'lockPath')
  const args = requireStringArray(value.args, 'args')
  const env = requireStringRecord(value.env ?? {}, 'env')

  return {
    schemaVersion: 1,
    command,
    args,
    cwd,
    env,
    heartbeatPath,
    statePath,
    ...(lockPath ? { lockPath } : {}),
    maxRestarts: requireInteger(value.maxRestarts, 'maxRestarts', 0, 20),
    startupGraceMs: requireInteger(
      value.startupGraceMs,
      'startupGraceMs',
      100,
      120_000
    ),
    heartbeatTimeoutMs: requireInteger(
      value.heartbeatTimeoutMs,
      'heartbeatTimeoutMs',
      100,
      120_000
    ),
    heartbeatPollMs: requireInteger(
      value.heartbeatPollMs,
      'heartbeatPollMs',
      50,
      10_000
    ),
    restartBackoffMs: requireInteger(
      value.restartBackoffMs,
      'restartBackoffMs',
      0,
      120_000
    )
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Watchdog ${name} 必须是非空字符串`)
  }
  return value
}

function requireStringArray(value: unknown, name: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string')
  ) {
    throw new Error(`Watchdog ${name} 必须是字符串数组`)
  }
  return value
}

function requireStringRecord(
  value: unknown,
  name: string
): Record<string, string> {
  if (
    !isRecord(value) ||
    !Object.values(value).every((item) => typeof item === 'string')
  ) {
    throw new Error(`Watchdog ${name} 必须是字符串字典`)
  }
  return value as Record<string, string>
}

function requireInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number
): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`Watchdog ${name} 必须是 ${minimum}–${maximum} 的整数`)
  }
  return value
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
