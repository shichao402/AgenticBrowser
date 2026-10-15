import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'

import { writeJsonAtomic } from './atomic-file'

export const WATCHDOG_AUTOSTART_ARGUMENT = '--watchdog-autostart'
const WATCHDOG_SMOKE_ARGUMENT = '--watchdog-smoke-child'

export interface PackagedWatchdogConfig {
  schemaVersion: 1
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  heartbeatPath: string
  statePath: string
  lockPath: string
  maxRestarts: number
  startupGraceMs: number
  heartbeatTimeoutMs: number
  heartbeatPollMs: number
  restartBackoffMs: number
}

interface PackagedWatchdogPaths {
  executablePath: string
  resourcesPath: string
  userDataPath: string
}

export function createPackagedWatchdogConfig(
  paths: PackagedWatchdogPaths,
  processArguments: string[]
): PackagedWatchdogConfig {
  const runtimeDirectory = join(paths.userDataPath, 'runtime')
  return {
    schemaVersion: 1,
    command: paths.executablePath,
    args: processArguments.includes(WATCHDOG_SMOKE_ARGUMENT)
      ? [WATCHDOG_SMOKE_ARGUMENT]
      : [],
    cwd: dirname(paths.executablePath),
    env: {
      AGENTIC_USER_DATA_PATH: paths.userDataPath
    },
    heartbeatPath: join(runtimeDirectory, 'main-heartbeat.json'),
    statePath: join(runtimeDirectory, 'watchdog-state.json'),
    lockPath: join(runtimeDirectory, 'watchdog.lock'),
    maxRestarts: 3,
    startupGraceMs: 20_000,
    heartbeatTimeoutMs: 2_500,
    heartbeatPollMs: 500,
    restartBackoffMs: 1_000
  }
}

export async function launchPackagedWatchdog(
  paths: PackagedWatchdogPaths,
  processArguments: string[],
  environment: NodeJS.ProcessEnv = process.env
): Promise<number | undefined> {
  const config = createPackagedWatchdogConfig(paths, processArguments)
  const configPath = join(paths.userDataPath, 'runtime', 'watchdog-config.json')
  await writeJsonAtomic(configPath, config)

  const watchdogScript = join(
    paths.resourcesPath,
    'app.asar',
    'out',
    'main',
    'watchdog.js'
  )
  const child = spawn(paths.executablePath, [watchdogScript, configPath], {
    cwd: config.cwd,
    detached: true,
    env: {
      ...environment,
      ELECTRON_RUN_AS_NODE: '1'
    },
    stdio: 'ignore',
    windowsHide: true
  })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  child.unref()
  return child.pid
}
