import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const repositoryRoot = process.cwd()
const smokeResultPath = join(repositoryRoot, 'watchdog-smoke-result.json')
const packagedMode = process.argv.includes('--packaged')

async function main() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'agentic-browser-watchdog-'))
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Set-Cookie': 'agentic_watchdog_session=preserved; Path=/; SameSite=Lax'
    })
    response.end(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Watchdog checkpoint probe</title></head>
  <body><h1>Watchdog checkpoint probe</h1></body>
</html>`)
  })

  let watchdog = null
  let watchdogOutput = ''

  try {
    const port = await listen(server)
    const targetUrl = `http://127.0.0.1:${port}/checkpoint-target`
    const configPath = join(temporaryRoot, 'watchdog-config.json')
    const checkpointPath = join(temporaryRoot, 'browser-checkpoint.json')
    const childResultPath = join(temporaryRoot, 'child-result.json')
    const userDataPath = join(temporaryRoot, 'user-data')
    const runtimeRoot = packagedMode
      ? join(userDataPath, 'runtime')
      : temporaryRoot
    const heartbeatPath = join(runtimeRoot, 'main-heartbeat.json')
    const statePath = join(runtimeRoot, 'watchdog-state.json')
    const lockPath = join(runtimeRoot, 'watchdog.lock')

    if (!packagedMode) {
      await writeFile(
        configPath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            command: electronPath,
            args: ['.', '--watchdog-smoke-child'],
            cwd: repositoryRoot,
            env: {
              AGENTIC_USER_DATA_PATH: userDataPath,
              AGENTIC_CHECKPOINT_PATH: checkpointPath,
              AGENTIC_WATCHDOG_SMOKE_URL: targetUrl,
              AGENTIC_WATCHDOG_CHILD_RESULT_PATH: childResultPath
            },
            heartbeatPath,
            statePath,
            lockPath,
            maxRestarts: 1,
            startupGraceMs: 15_000,
            heartbeatTimeoutMs: 2_000,
            heartbeatPollMs: 100,
            restartBackoffMs: 250
          },
          null,
          2
        )}\n`,
        'utf8'
      )
    }

    const packagedExecutable = packagedMode
      ? await resolvePackagedExecutable()
      : null
    watchdog = packagedExecutable
      ? spawn(packagedExecutable, ['--watchdog-smoke-child'], {
          cwd: dirname(packagedExecutable),
          env: {
            ...process.env,
            AGENTIC_USER_DATA_PATH: userDataPath,
            AGENTIC_CHECKPOINT_PATH: checkpointPath,
            AGENTIC_WATCHDOG_SMOKE_URL: targetUrl,
            AGENTIC_WATCHDOG_CHILD_RESULT_PATH: childResultPath
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: false
        })
      : spawn(
          process.execPath,
          [join(repositoryRoot, 'out/main/watchdog.js'), configPath],
          {
            cwd: repositoryRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: false
          }
        )
    const launcherExit = waitForExit(watchdog, 45_000)
    watchdog.stdout.on('data', (chunk) => {
      const text = String(chunk)
      watchdogOutput += text
      process.stdout.write(text)
    })
    watchdog.stderr.on('data', (chunk) => {
      const text = String(chunk)
      watchdogOutput += text
      process.stderr.write(text)
    })

    const firstChild = await waitForJson(
      childResultPath,
      (value) => value.ready === true && value.restartCount === 0,
      20_000
    )
    const firstState = await waitForJson(
      statePath,
      (value) =>
        value.childPid === firstChild.pid &&
        (value.phase === 'starting' || value.phase === 'running'),
      5_000
    )

    if (
      firstChild.restoredFromCheckpoint !== false ||
      firstChild.profileCookiePresent !== true ||
      firstChild.heartbeatActive !== true ||
      firstChild.startupIntegrationPassed !== true ||
      firstChild.checkpoint?.url !== targetUrl
    ) {
      throw new Error('首次启动没有建立预期的 Profile、heartbeat 或检查点')
    }

    let duplicateSuppressed = null
    if (packagedExecutable) {
      const duplicateLauncher = spawn(
        packagedExecutable,
        ['--watchdog-smoke-child'],
        {
          cwd: dirname(packagedExecutable),
          env: {
            ...process.env,
            AGENTIC_USER_DATA_PATH: userDataPath,
            AGENTIC_CHECKPOINT_PATH: checkpointPath,
            AGENTIC_WATCHDOG_SMOKE_URL: targetUrl,
            AGENTIC_WATCHDOG_CHILD_RESULT_PATH: childResultPath
          },
          stdio: 'ignore',
          windowsHide: false
        }
      )
      const duplicateExit = await waitForExit(duplicateLauncher, 10_000)
      await delay(750)
      const stateAfterDuplicate = await readJson(statePath)
      duplicateSuppressed =
        duplicateExit.code === 0 &&
        stateAfterDuplicate.watchdogPid === firstState.watchdogPid &&
        stateAfterDuplicate.childPid === firstChild.pid
    }

    killProcess(firstChild.pid)
    const exit = await launcherExit
    const finalChild = packagedExecutable
      ? await waitForJson(
          childResultPath,
          (value) => value.passed === true && value.restartCount === 1,
          30_000
        )
      : await readJson(childResultPath)
    const finalState = packagedExecutable
      ? await waitForJson(
          statePath,
          (value) => value.phase === 'stopped' && value.launches === 2,
          10_000
        )
      : await readJson(statePath)
    const checkpoint = await readJson(checkpointPath)
    const lockReleased = await waitForMissing(lockPath, 5_000)
    const restart = finalState.restartHistory?.[0]
    const passed =
      exit.code === 0 &&
      finalChild.passed === true &&
      finalChild.restartCount === 1 &&
      finalChild.pid !== firstChild.pid &&
      finalChild.restoredFromCheckpoint === true &&
      finalChild.snapshot?.url === targetUrl &&
      finalChild.checkpoint?.url === targetUrl &&
      finalChild.profileCookiePresent === true &&
      checkpoint.url === targetUrl &&
      finalState.phase === 'stopped' &&
      finalState.launches === 2 &&
      finalState.restartCount === 1 &&
      Array.isArray(finalState.restartHistory) &&
      finalState.restartHistory.length === 1 &&
      restart.code !== 0 &&
      lockReleased &&
      (duplicateSuppressed === null || duplicateSuppressed)

    const result = {
      passed,
      targetUrl,
      firstChild,
      firstState,
      finalChild,
      finalState,
      checkpoint,
      lockReleased,
      packagedMode,
      duplicateSuppressed,
      watchdogExit: exit
    }
    await writeFile(smokeResultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    console.log(`AGENTIC_BROWSER_WATCHDOG_SMOKE ${JSON.stringify(result)}`)

    if (!passed) {
      throw new Error('Watchdog smoke 验收条件未全部满足')
    }
  } catch (error) {
    await writeFile(
      smokeResultPath,
      `${JSON.stringify(
        {
          passed: false,
          error: error instanceof Error ? error.stack ?? error.message : String(error),
          watchdogOutput
        },
        null,
        2
      )}\n`,
      'utf8'
    )
    throw error
  } finally {
    if (watchdog) {
      await terminateWatchdog(watchdog)
    }
    await closeServer(server)
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

function waitForJson(filePath, predicate, timeoutMs) {
  const startedAt = Date.now()

  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const value = await readJson(filePath)
        if (predicate(value)) {
          resolve(value)
          return
        }
      } catch (error) {
        if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
          reject(error)
          return
        }
      }

      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`等待 ${filePath} 超时`))
        return
      }
      setTimeout(poll, 100)
    }

    void poll()
  })
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`等待进程 ${child.pid ?? 'unknown'} 退出超时`))
    }, timeoutMs)

    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function fileMissing(filePath) {
  try {
    await readFile(filePath)
    return false
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return true
    }
    throw error
  }
}

async function waitForMissing(filePath, timeoutMs) {
  const startedAt = Date.now()
  while (!(await fileMissing(filePath))) {
    if (Date.now() - startedAt >= timeoutMs) {
      return false
    }
    await delay(50)
  }
  return true
}

function killProcess(pid) {
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      throw error
    }
  }
}

async function terminateWatchdog(child) {
  if (child.exitCode !== null) {
    return
  }

  child.kill('SIGTERM')
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })

  if (child.exitCode === null) {
    child.kill('SIGKILL')
  }
}

async function resolvePackagedExecutable() {
  if (process.env.AGENTIC_PACKAGED_EXECUTABLE) {
    await access(process.env.AGENTIC_PACKAGED_EXECUTABLE)
    return process.env.AGENTIC_PACKAGED_EXECUTABLE
  }

  const candidates =
    process.platform === 'win32'
      ? [join(repositoryRoot, 'release', 'win-unpacked', 'AgenticBrowser.exe')]
      : process.platform === 'darwin'
        ? [
            join(
              repositoryRoot,
              'release',
              'mac',
              'AgenticBrowser.app',
              'Contents',
              'MacOS',
              'AgenticBrowser'
            ),
            join(
              repositoryRoot,
              'release',
              'mac-arm64',
              'AgenticBrowser.app',
              'Contents',
              'MacOS',
              'AgenticBrowser'
            )
          ]
        : []

  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error
      }
    }
  }
  throw new Error(`找不到当前平台的打包可执行文件：${candidates.join(', ')}`)
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server.address().port)
    })
  })
}

function closeServer(server) {
  if (!server.listening) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
