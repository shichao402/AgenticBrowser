import { randomInt } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const PROBE_QUERY = '__agentic_phase0_probe=1'
const PROBE_PORT_MIN = 20_000
const PROBE_PORT_MAX_EXCLUSIVE = 45_000
const PROBE_PORT_ATTEMPTS = 100

export interface PhaseZeroProbeServer {
  topUrl: string
  close(): Promise<void>
}

function frameDocument(label: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${label}</title>
    <script>
      document.dispatchEvent(
        new CustomEvent('__agentic-phase2-inline-probe')
      );
      globalThis.__phaseZeroInlineObservation = {
        label: ${JSON.stringify(label)},
        probeVisibleAtInline: Boolean(globalThis.__agenticPhaseZeroProbe),
        preloadReadyState: globalThis.__agenticPhaseZeroProbe?.readyState ?? null,
        inlineReadyState: document.readyState,
        inlineAt: performance.now(),
        strategyMarkerAtInline:
          document.documentElement.dataset.agenticStrategyStart ?? null,
        strategyNodeAtInline:
          document.documentElement.dataset.agenticStrategyNode ?? null,
        strategyPrivateVisibleAtInline:
          Boolean(globalThis.__agenticStrategyPrivate)
      };
    </script>
  </head>
  <body><p>${label}</p></body>
</html>`
}

function topDocument(crossOriginUrl: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>AgenticBrowser Phase 0 Probe</title>
    <script>
      document.dispatchEvent(
        new CustomEvent('__agentic-phase2-inline-probe')
      );
      globalThis.__phaseZeroInlineObservation = {
        label: 'top',
        probeVisibleAtInline: Boolean(globalThis.__agenticPhaseZeroProbe),
        preloadReadyState: globalThis.__agenticPhaseZeroProbe?.readyState ?? null,
        inlineReadyState: document.readyState,
        inlineAt: performance.now(),
        strategyMarkerAtInline:
          document.documentElement.dataset.agenticStrategyStart ?? null,
        strategyNodeAtInline:
          document.documentElement.dataset.agenticStrategyNode ?? null,
        strategyPrivateVisibleAtInline:
          Boolean(globalThis.__agenticStrategyPrivate)
      };
      document.cookie = 'agentic_phase0_session=preserved; Path=/; SameSite=Lax';
      let tick = 0;
      setInterval(() => {
        document.documentElement.dataset.tick = String(++tick);
      }, 50);
    </script>
  </head>
  <body>
    <h1>Phase 0 Probe</h1>
    <iframe id="same-origin" src="/same?${PROBE_QUERY}"></iframe>
    <iframe id="cross-origin" src="${crossOriginUrl}"></iframe>
  </body>
</html>`
}

async function listen(server: Server, host: string): Promise<number> {
  for (let attempt = 0; attempt < PROBE_PORT_ATTEMPTS; attempt += 1) {
    const port = randomInt(PROBE_PORT_MIN, PROBE_PORT_MAX_EXCLUSIVE)
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.off('error', reject)
          resolve()
        })
      })
      return (server.address() as AddressInfo).port
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EADDRINUSE' && code !== 'EACCES') {
        throw error
      }
    }
  }
  throw new Error('无法为 Phase 0 探针分配安全端口')
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}

export async function startPhaseZeroProbeServer(): Promise<PhaseZeroProbeServer> {
  const crossServer = createServer((request, response) => {
    if (request.url?.startsWith('/strategy-data')) {
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      })
      response.end('{"marker":"network-ok"}')
      return
    }
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    })
    response.end(frameDocument('cross-origin'))
  })
  const crossPort = await listen(crossServer, 'localhost')
  const crossUrl = `http://localhost:${crossPort}/cross?${PROBE_QUERY}`

  const topServer = createServer((request, response) => {
    if (request.url?.startsWith('/disconnect')) {
      request.socket.destroy()
      return
    }
    if (request.url?.startsWith('/sample.mp3')) {
      const body = Buffer.alloc(4096, 0x5a)
      response.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Disposition': 'attachment; filename="meeting:sample?.mp3"',
        'Content-Length': String(body.byteLength),
        'Cache-Control': 'no-store'
      })
      response.end(body)
      return
    }
    if (request.url?.startsWith('/strategy-data')) {
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      })
      response.end('{"marker":"network-ok"}')
      return
    }
    if (request.url?.startsWith('/popup')) {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      })
      response.end(frameDocument('popup'))
      return
    }
    const isSameOriginFrame = request.url?.startsWith('/same') === true
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    })
    response.end(isSameOriginFrame ? frameDocument('same-origin') : topDocument(crossUrl))
  })
  const topPort = await listen(topServer, '127.0.0.1')

  return {
    topUrl: `http://127.0.0.1:${topPort}/?${PROBE_QUERY}`,
    close: async () => {
      await Promise.all([closeServer(topServer), closeServer(crossServer)])
    }
  }
}
