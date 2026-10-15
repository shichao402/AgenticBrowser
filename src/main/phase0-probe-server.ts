import { randomInt } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const PROBE_QUERY = '__agentic_phase0_probe=1'
const PROBE_PORT_MIN = 20_000
const PROBE_PORT_MAX_EXCLUSIVE = 45_000
const PROBE_PORT_ATTEMPTS = 100

export interface PhaseZeroProbeServer {
  topUrl: string
  knowledgePlanetFeedUrl: string
  knowledgePlanetLoginUrl: string
  knowledgePlanetChangedFeedUrl: string
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

function knowledgePlanetFeedDocument(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Knowledge Planet Fixture</title>
  </head>
  <body>
    <article class="topic" data-topic-id="meeting-001">
      <p class="content">会议纪要：Agentic Browser 试点录音</p>
      <a class="audio" href="/sample.mp3?topic=meeting-001">下载 MP3</a>
      <a class="audio" href="/sample-2.mp3?topic=meeting-001">
        下载补充 MP3
      </a>
      <app-file-gallery data-file-id="meeting-button">
        <span class="file-name">meeting-button.mp3</span>
        <button
          class="download"
          onclick="
            const link = document.createElement('a');
            link.href = '/sample-button.mp3?topic=meeting-001';
            link.download = 'meeting-button.mp3';
            document.body.append(link);
            link.click();
            link.remove();
          "
        >
          点击下载 MP3
        </button>
      </app-file-gallery>
    </article>
    <article class="topic" data-topic-id="chat-001">
      <p class="content">普通闲聊，不属于采集范围</p>
    </article>
  </body>
</html>`
}

function knowledgePlanetLoginDocument(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Knowledge Planet Login Fixture</title>
  </head>
  <body>
    <h1>登录知识星球</h1>
    <p>获取登录二维码</p>
  </body>
</html>`
}

function knowledgePlanetChangedFeedDocument(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Knowledge Planet Changed Fixture</title>
  </head>
  <body>
    <article class="topic" data-topic-id="meeting-001">
      <p class="content">会议纪要：页面结构变化探针</p>
      <a class="detail" href="/knowledge-planet-detail-missing">
        打开详情
      </a>
    </article>
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
    if (request.url?.startsWith('/sample-2.mp3')) {
      const body = Buffer.alloc(2048, 0x33)
      response.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Disposition': 'attachment; filename="meeting-followup.mp3"',
        'Content-Length': String(body.byteLength),
        'Cache-Control': 'no-store'
      })
      response.end(body)
      return
    }
    if (request.url?.startsWith('/sample-button.mp3')) {
      const body = Buffer.alloc(1024, 0x71)
      response.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Disposition': 'attachment; filename="meeting-button.mp3"',
        'Content-Length': String(body.byteLength),
        'Cache-Control': 'no-store'
      })
      response.end(body)
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
    if (request.url?.startsWith('/knowledge-planet-feed')) {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      })
      response.end(knowledgePlanetFeedDocument())
      return
    }
    if (request.url?.startsWith('/knowledge-planet-login')) {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      })
      response.end(knowledgePlanetLoginDocument())
      return
    }
    if (request.url?.startsWith('/knowledge-planet-changed-feed')) {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      })
      response.end(knowledgePlanetChangedFeedDocument())
      return
    }
    if (request.url?.startsWith('/knowledge-planet-detail-missing')) {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      })
      response.end(frameDocument('knowledge-planet-detail-missing'))
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
    knowledgePlanetFeedUrl:
      `http://127.0.0.1:${topPort}/knowledge-planet-feed`,
    knowledgePlanetLoginUrl:
      `http://127.0.0.1:${topPort}/knowledge-planet-login`,
    knowledgePlanetChangedFeedUrl:
      `http://127.0.0.1:${topPort}/knowledge-planet-changed-feed`,
    close: async () => {
      await Promise.all([closeServer(topServer), closeServer(crossServer)])
    }
  }
}
