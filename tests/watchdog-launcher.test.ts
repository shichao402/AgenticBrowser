import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  createPackagedWatchdogConfig,
  WATCHDOG_AUTOSTART_ARGUMENT
} from '../src/main/watchdog-launcher'

describe('packaged Watchdog launcher', () => {
  const paths = {
    executablePath: join('C:', 'Program Files', 'AgenticBrowser', 'app.exe'),
    resourcesPath: join('C:', 'Program Files', 'AgenticBrowser', 'resources'),
    userDataPath: join('C:', 'Users', 'test', 'AgenticBrowser')
  }

  it('builds a bounded config rooted in trusted application paths', () => {
    const config = createPackagedWatchdogConfig(paths, [])

    expect(config).toMatchObject({
      schemaVersion: 1,
      command: paths.executablePath,
      args: [],
      cwd: dirname(paths.executablePath),
      env: {
        AGENTIC_USER_DATA_PATH: paths.userDataPath
      },
      heartbeatPath: join(paths.userDataPath, 'runtime', 'main-heartbeat.json'),
      statePath: join(paths.userDataPath, 'runtime', 'watchdog-state.json'),
      lockPath: join(paths.userDataPath, 'runtime', 'watchdog.lock')
    })
    expect(config.maxRestarts).toBeGreaterThan(0)
    expect(config.heartbeatTimeoutMs).toBeGreaterThan(config.heartbeatPollMs)
  })

  it('does not forward arbitrary or autostart arguments into the managed child', () => {
    expect(
      createPackagedWatchdogConfig(paths, [
        WATCHDOG_AUTOSTART_ARGUMENT,
        '--unknown'
      ]).args
    ).toEqual([])
  })

  it('forwards only the packaged smoke child marker for fault injection', () => {
    expect(
      createPackagedWatchdogConfig(paths, [
        '--unknown',
        '--watchdog-smoke-child'
      ]).args
    ).toEqual(['--watchdog-smoke-child'])
  })
})
