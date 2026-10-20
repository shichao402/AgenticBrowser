import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { isNodeError, readJsonFile, writeJsonAtomic } from './atomic-file'
import { isRecord, parseWatchdogConfig } from './watchdog-config'
import type { WatchdogConfig, WatchdogState } from './watchdog-types'

interface ChildOutcome {
  code: number | null
  signal: NodeJS.Signals | null
  heartbeatTimedOut: boolean
  error?: string
}

let stopRequested = false
let currentChild: ChildProcess | null = null

async function main(): Promise<number> {
  const configPath = process.argv[2]
  if (!configPath) {
    throw new Error('用法：watchdog <config.json>')
  }

  const config = parseWatchdogConfig(
    JSON.parse(await readFile(configPath, 'utf8')) as unknown
  )
  const ownsLock = config.lockPath
    ? await acquireWatchdogLock(config.lockPath)
    : true
  if (!ownsLock) {
    return 0
  }

  try {
    process.on('SIGINT', requestStop)
    process.on('SIGTERM', requestStop)

    let launches = 0
    let lastExit: WatchdogState['lastExit']
    const restartHistory: NonNullable<WatchdogState['restartHistory']> = []

    for (
      let restartCount = 0;
      restartCount <= config.maxRestarts;
      restartCount += 1
    ) {
      if (stopRequested) {
        await writeState(config, {
          phase: 'stopped',
          childPid: null,
          restartCount,
          launches,
          detail: 'watchdog 收到停止信号',
          ...(lastExit ? { lastExit } : {})
        })
        return 0
      }

      if (restartCount > 0) {
        await writeState(config, {
          phase: 'backoff',
          childPid: null,
          restartCount,
          launches,
          detail: `等待 ${config.restartBackoffMs} ms 后重启`,
          ...(lastExit ? { lastExit } : {})
        })
        await delay(config.restartBackoffMs)
      }

      await rm(config.heartbeatPath, { force: true })
      launches += 1
      const launchId = `${Date.now()}-${launches}`
      const childEnvironment: NodeJS.ProcessEnv = {
        ...process.env,
        ...config.env,
        AGENTIC_WATCHDOG_MANAGED: '1',
        AGENTIC_WATCHDOG_HEARTBEAT_PATH: config.heartbeatPath,
        AGENTIC_WATCHDOG_LAUNCH_ID: launchId,
        AGENTIC_WATCHDOG_RESTART_COUNT: String(restartCount)
      }
      delete childEnvironment.ELECTRON_RUN_AS_NODE
      const child = spawn(config.command, config.args, {
        cwd: config.cwd,
        env: childEnvironment,
        stdio: 'inherit',
        windowsHide: false
      })
      currentChild = child

      await writeState(config, {
        phase: 'starting',
        childPid: child.pid ?? null,
        restartCount,
        launches,
        detail: `launch ${launchId}`,
        ...(lastExit ? { lastExit } : {})
      })

      const outcome = await monitorChild(
        config,
        child,
        launchId,
        restartCount,
        launches
      )
      currentChild = null
      lastExit = {
        code: outcome.code,
        signal: outcome.signal,
        heartbeatTimedOut: outcome.heartbeatTimedOut
      }

      if (stopRequested || outcome.code === 0) {
        await writeState(config, {
          phase: 'stopped',
          childPid: null,
          restartCount,
          launches,
          detail: stopRequested ? 'watchdog 已停止' : '子进程正常退出',
          lastExit,
          ...(restartHistory.length > 0 ? { restartHistory } : {})
        })
        return 0
      }

      restartHistory.push({
        restartCount,
        ...lastExit,
        timestamp: new Date().toISOString()
      })

      if (restartCount === config.maxRestarts) {
        await writeState(config, {
          phase: 'failed',
          childPid: null,
          restartCount,
          launches,
          detail: outcome.error ?? '重启预算已耗尽',
          lastExit,
          restartHistory
        })
        return 1
      }
    }

    return 1
  } finally {
    if (config.lockPath) {
      await rm(config.lockPath, { force: true }).catch(() => undefined)
    }
  }
}

function monitorChild(
  config: WatchdogConfig,
  child: ChildProcess,
  launchId: string,
  restartCount: number,
  launches: number
): Promise<ChildOutcome> {
  const launchedAt = Date.now()
  let heartbeatTimedOut = false
  let checkingHeartbeat = false
  let reportedRunning = false

  return new Promise((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | null = null

    const finish = (outcome: ChildOutcome): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearInterval(timer)
      }
      resolve(outcome)
    }

    child.once('error', (error) => {
      finish({
        code: null,
        signal: null,
        heartbeatTimedOut,
        error: error.message
      })
    })

    child.once('exit', (code, signal) => {
      finish({
        code,
        signal,
        heartbeatTimedOut
      })
    })

    timer = setInterval(() => {
      if (checkingHeartbeat || settled || stopRequested) {
        if (stopRequested && !child.killed) {
          child.kill('SIGKILL')
        }
        return
      }

      checkingHeartbeat = true
      void inspectHeartbeat(
        config.heartbeatPath,
        child.pid,
        launchId,
        config.heartbeatTimeoutMs
      )
        .then(async (healthy) => {
          if (settled) {
            return
          }

          if (healthy) {
            if (!reportedRunning) {
              reportedRunning = true
              await writeState(config, {
                phase: 'running',
                childPid: child.pid ?? null,
                restartCount,
                launches
              })
            }
            return
          }

          if (Date.now() - launchedAt > config.startupGraceMs) {
            heartbeatTimedOut = true
            child.kill('SIGKILL')
          }
        })
        .catch((error: unknown) => {
          console.error('检查 heartbeat 失败', error)
        })
        .finally(() => {
          checkingHeartbeat = false
        })
    }, config.heartbeatPollMs)
    timer.unref()
  })
}

async function inspectHeartbeat(
  heartbeatPath: string,
  childPid: number | undefined,
  launchId: string,
  heartbeatTimeoutMs: number
): Promise<boolean> {
  const value = await readJsonFile(heartbeatPath)
  if (!isRecord(value)) {
    return false
  }

  if (
    value.pid !== childPid ||
    value.launchId !== launchId ||
    typeof value.timestamp !== 'string'
  ) {
    return false
  }

  const timestamp = Date.parse(value.timestamp)
  const age = Date.now() - timestamp
  return Number.isFinite(timestamp) && age >= 0 && age <= heartbeatTimeoutMs
}

async function acquireWatchdogLock(lockPath: string): Promise<boolean> {
  await mkdir(dirname(lockPath), { recursive: true })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(
        lockPath,
        `${JSON.stringify({
          schemaVersion: 1,
          pid: process.pid,
          createdAt: new Date().toISOString()
        })}\n`,
        {
          encoding: 'utf8',
          flag: 'wx'
        }
      )
      return true
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) {
        throw error
      }

      const existing = await readJsonFile(lockPath).catch(() => null)
      const existingPid =
        isRecord(existing) &&
        typeof existing.pid === 'number' &&
        Number.isInteger(existing.pid)
          ? existing.pid
          : null
      if (existingPid !== null && isProcessAlive(existingPid)) {
        return false
      }
      await rm(lockPath, { force: true })
    }
  }

  return false
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !isNodeError(error, 'ESRCH')
  }
}

async function writeState(
  config: WatchdogConfig,
  state: Omit<WatchdogState, 'schemaVersion' | 'watchdogPid' | 'timestamp'>
): Promise<void> {
  await writeJsonAtomic(config.statePath, {
    schemaVersion: 1,
    watchdogPid: process.pid,
    timestamp: new Date().toISOString(),
    ...state
  } satisfies WatchdogState)
}

function requestStop(): void {
  stopRequested = true
  currentChild?.kill('SIGKILL')
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

void main()
  .then((exitCode) => {
    process.exitCode = exitCode
  })
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
