import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const repositoryRoot = process.cwd()
const smokeResultPath = join(
  repositoryRoot,
  'phase3-project-download-renderer-recovery-smoke-result.json'
)
const expectedBytes = 2 * 1024 * 1024
const payload = Buffer.alloc(expectedBytes, 0x52)
const expectedSha256 = createHash('sha256').update(payload).digest('hex')

async function main() {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), 'agentic-browser-project-download-renderer-')
  )
  const activeTimers = new Set()
  let downloadRequests = 0
  let child = null
  let childOutput = ''
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/slow-sample.mp3') {
      downloadRequests += 1
      response.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(payload.byteLength),
        'Cache-Control': 'no-store'
      })
      let offset = 0
      const stop = () => {
        clearInterval(timer)
        activeTimers.delete(timer)
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
  <head><meta charset="utf-8"><title>Renderer download recovery</title></head>
  <body><h1>Renderer download recovery</h1></body>
</html>`)
  })

  try {
    const port = await listen(server)
    const pageUrl = `http://127.0.0.1:${port}/project-download-renderer-recovery`
    const childResultPath = join(temporaryRoot, 'child-result.json')
    child = spawn(
      electronPath,
      ['.', '--project-download-renderer-recovery-smoke-child'],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          AGENTIC_USER_DATA_PATH: join(temporaryRoot, 'user-data'),
          AGENTIC_PROJECT_DOWNLOAD_RENDERER_URL: pageUrl,
          AGENTIC_PROJECT_DOWNLOAD_RENDERER_OUTPUT_ROOT: join(
            temporaryRoot,
            'project-output'
          ),
          AGENTIC_PROJECT_DOWNLOAD_RENDERER_RESULT_PATH: childResultPath,
          AGENTIC_PROJECT_DOWNLOAD_RENDERER_EXPECTED_BYTES:
            String(expectedBytes),
          AGENTIC_PROJECT_DOWNLOAD_RENDERER_EXPECTED_SHA256: expectedSha256
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: false
      }
    )
    child.stdout.on('data', (chunk) => {
      const text = String(chunk)
      childOutput += text
      process.stdout.write(text)
    })
    child.stderr.on('data', (chunk) => {
      const text = String(chunk)
      childOutput += text
      process.stderr.write(text)
    })
    const exit = await waitForExit(child, 120_000)
    const childResult = await readJson(childResultPath)
    const passed =
      exit.code === 0 &&
      childResult.passed === true &&
      childResult.mainPid === child.pid &&
      downloadRequests === 1
    const result = {
      passed,
      pageUrl,
      expectedBytes,
      expectedSha256,
      downloadRequests,
      childResult,
      childExit: exit
    }
    await writeFile(
      smokeResultPath,
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8'
    )
    console.log(
      `AGENTIC_BROWSER_PROJECT_DOWNLOAD_RENDERER_RECOVERY_SMOKE ${JSON.stringify(
        result
      )}`
    )
    if (!passed) {
      throw new Error('Project 下载 renderer 恢复 smoke 验收条件未全部满足')
    }
  } catch (error) {
    await writeFile(
      smokeResultPath,
      `${JSON.stringify(
        {
          passed: false,
          error:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
          downloadRequests,
          childOutput
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
    if (child) {
      await terminateChild(child)
    }
    await closeServer(server)
    await rm(temporaryRoot, { recursive: true, force: true })
  }
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

async function terminateChild(child) {
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
