import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const repositoryRoot = process.cwd()
const smokeResultPath = join(
  repositoryRoot,
  'phase3-project-download-recovery-smoke-result.json'
)
const expectedBytes = 1024 * 1024
const payload = Buffer.alloc(expectedBytes, 0x5a)
const expectedSha256 = createHash('sha256').update(payload).digest('hex')

async function main() {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), 'agentic-browser-project-download-recovery-')
  )
  let downloadRequests = 0
  const activeTimers = new Set()
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/slow-sample.mp3') {
      downloadRequests += 1
      response.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(payload.byteLength),
        'Cache-Control': 'no-store'
      })
      if (downloadRequests > 1) {
        response.end(payload)
        return
      }

      let offset = 0
      const stop = () => {
        if (timer) {
          clearInterval(timer)
          activeTimers.delete(timer)
        }
      }
      const writeChunk = () => {
        if (response.destroyed || offset >= payload.byteLength) {
          stop()
          if (!response.destroyed) {
            response.end()
          }
          return
        }
        const next = Math.min(offset + 16 * 1024, payload.byteLength)
        response.write(payload.subarray(offset, next))
        offset = next
      }
      const timer = setInterval(writeChunk, 50)
      activeTimers.add(timer)
      response.once('close', stop)
      response.once('error', stop)
      writeChunk()
      return
    }

    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    })
    response.end(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Project download recovery</title></head>
  <body><h1>Project download recovery</h1></body>
</html>`)
  })

  let watchdog = null
  let watchdogOutput = ''

  try {
    const port = await listen(server)
    const pageUrl =
      `http://127.0.0.1:${port}/project-download-recovery`
    const userDataPath = join(temporaryRoot, 'user-data')
    const outputRoot = join(temporaryRoot, 'project-output')
    const childResultPath = join(temporaryRoot, 'child-result.json')
    const configPath = join(temporaryRoot, 'watchdog-config.json')
    const heartbeatPath = join(temporaryRoot, 'main-heartbeat.json')
    const statePath = join(temporaryRoot, 'watchdog-state.json')
    const lockPath = join(temporaryRoot, 'watchdog.lock')
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          command: electronPath,
          args: ['.', '--project-download-recovery-smoke-child'],
          cwd: repositoryRoot,
          env: {
            AGENTIC_USER_DATA_PATH: userDataPath,
            AGENTIC_PROJECT_DOWNLOAD_RECOVERY_URL: pageUrl,
            AGENTIC_PROJECT_DOWNLOAD_RECOVERY_OUTPUT_ROOT: outputRoot,
            AGENTIC_PROJECT_DOWNLOAD_RECOVERY_RESULT_PATH: childResultPath,
            AGENTIC_PROJECT_DOWNLOAD_RECOVERY_EXPECTED_BYTES:
              String(expectedBytes),
            AGENTIC_PROJECT_DOWNLOAD_RECOVERY_EXPECTED_SHA256:
              expectedSha256
          },
          heartbeatPath,
          statePath,
          lockPath,
          maxRestarts: 1,
          startupGraceMs: 20_000,
          heartbeatTimeoutMs: 2_500,
          heartbeatPollMs: 100,
          restartBackoffMs: 250
        },
        null,
        2
      )}\n`,
      'utf8'
    )

    watchdog = spawn(
      process.execPath,
      [join(repositoryRoot, 'out/main/watchdog.js'), configPath],
      {
        cwd: repositoryRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: false
      }
    )
    const watchdogExit = waitForExit(watchdog, 120_000)
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
      (value) =>
        value.ready === true &&
        value.stage === 'kill-ready' &&
        value.restartCount === 0,
      45_000
    )
    const firstState = await waitForJson(
      statePath,
      (value) =>
        value.childPid === firstChild.pid &&
        (value.phase === 'starting' || value.phase === 'running'),
      5_000
    )
    if (
      firstChild.interrupted?.receivedBytes <= 0 ||
      firstChild.interrupted?.receivedBytes >= expectedBytes ||
      firstChild.runtime?.status !== 'waiting' ||
      downloadRequests !== 1
    ) {
      throw new Error('首次子进程没有停在部分下载等待态')
    }

    killProcess(firstChild.pid)
    const exit = await watchdogExit
    const finalChild = await readJson(childResultPath)
    const finalState = await readJson(statePath)
    const downloadState = await readJson(
      join(outputRoot, 'records', 'downloads.json')
    )
    const runtimeState = await readJson(
      join(userDataPath, 'runtime', 'project-runtimes.json')
    )
    const completed = downloadState.records.filter(
      (record) => record.status === 'completed'
    )
    const failed = downloadState.records.filter(
      (record) => record.status === 'failed'
    )
    const completedRecord = completed[0] ?? null
    const failedRecord = failed[0] ?? null
    const finalPayload = completedRecord
      ? await readFile(completedRecord.finalPath)
      : Buffer.alloc(0)
    const finalSha256 = createHash('sha256')
      .update(finalPayload)
      .digest('hex')
    const interruptedStat = failedRecord
      ? await stat(failedRecord.temporaryPath)
      : null
    const downloads = await readDirectoryNames(join(outputRoot, 'downloads'))
    const temporary = await readDirectoryNames(join(outputRoot, 'tmp'))
    const recoveredRuntime = runtimeState.runtimes.find(
      ({ runtime }) =>
        runtime.projectId === 'smoke-project-download-recovery'
    )?.runtime
    const lockReleased = await waitForMissing(lockPath, 5_000)
    const restart = finalState.restartHistory?.[0]
    const passed =
      exit.code === 0 &&
      finalChild.passed === true &&
      finalChild.restartCount === 1 &&
      finalChild.pid !== firstChild.pid &&
      finalState.phase === 'stopped' &&
      finalState.launches === 2 &&
      finalState.restartCount === 1 &&
      restart?.code !== 0 &&
      downloadRequests >= 2 &&
      failed.length === 1 &&
      completed.length === 1 &&
      failedRecord.errorCategory === 'unknown' &&
      interruptedStat.size > 0 &&
      interruptedStat.size < expectedBytes &&
      completedRecord.size === expectedBytes &&
      completedRecord.sha256 === expectedSha256 &&
      completedRecord.retryCount === 1 &&
      completedRecord.idempotencyKey === failedRecord.idempotencyKey &&
      completedRecord.finalPath === failedRecord.finalPath &&
      completedRecord.safeFileName === failedRecord.safeFileName &&
      finalPayload.byteLength === expectedBytes &&
      finalSha256 === expectedSha256 &&
      downloads.length === 1 &&
      temporary.length === 1 &&
      recoveredRuntime?.status === 'completed' &&
      recoveredRuntime.trigger === 'resume' &&
      recoveredRuntime.counters.downloaded === 1 &&
      recoveredRuntime.counters.downloadedBytes === expectedBytes &&
      lockReleased

    const result = {
      passed,
      pageUrl,
      expectedBytes,
      expectedSha256,
      firstChild,
      firstState,
      finalChild,
      finalState,
      downloadState,
      runtimeState,
      downloads,
      temporary,
      interruptedBytes: interruptedStat?.size ?? null,
      finalSha256,
      downloadRequests,
      lockReleased,
      watchdogExit: exit
    }
    await writeFile(
      smokeResultPath,
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8'
    )
    console.log(
      `AGENTIC_BROWSER_PROJECT_DOWNLOAD_RECOVERY_SMOKE ${JSON.stringify(
        result
      )}`
    )
    if (!passed) {
      throw new Error('Project 下载强杀恢复 smoke 验收条件未全部满足')
    }
  } catch (error) {
    await writeFile(
      smokeResultPath,
      `${JSON.stringify(
        {
          passed: false,
          error:
            error instanceof Error
              ? error.stack ?? error.message
              : String(error),
          watchdogOutput
        },
        null,
        2
      )}\n`,
      'utf8'
    )
    throw error
  } finally {
    for (const timer of activeTimers) {
      clearInterval(timer)
    }
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

async function readDirectoryNames(path) {
  try {
    return (await readdir(path)).sort()
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return []
    }
    throw error
  }
}

async function waitForMissing(filePath, timeoutMs) {
  const startedAt = Date.now()
  while (await fileExists(filePath)) {
    if (Date.now() - startedAt >= timeoutMs) {
      return false
    }
    await delay(50)
  }
  return true
}

async function fileExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false
    }
    throw error
  }
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
