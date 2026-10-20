import { contextBridge, ipcRenderer, webFrame } from 'electron'

import type {
  StrategyBootstrapEntry,
  StrategyBootstrapResponse,
  StrategyHostMethod,
  StrategyRuntimeSignalType
} from '../shared/contracts'

// session.registerPreloadScript 的 frame preload 必须保持单文件。
// 沙箱/OOPIF 中不能依赖 Vite 拆出的相对 CommonJS chunk。
const STRATEGY_RUNTIME_CHANNELS = {
  bootstrap: 'strategy-runtime:bootstrap',
  signal: 'strategy-runtime:signal',
  invoke: 'strategy-runtime:invoke'
} as const

interface FrameGlobals {
  location: {
    href: string
  }
  document: {
    readyState: string
  }
  performance: {
    now(): number
  }
}

const frame = globalThis as unknown as FrameGlobals

if (process.argv.includes('--agentic-phase0-probe')) {
  contextBridge.exposeInMainWorld('__agenticPhaseZeroProbe', {
    installedAt: frame.performance.now(),
    readyState: frame.document.readyState,
    isMainFrame: process.isMainFrame,
    href: frame.location.href
  })
}

if (process.argv.includes('--agentic-strategy-runtime')) {
  installStrategies()
}

function installStrategies(): void {
  const response = ipcRenderer.sendSync(STRATEGY_RUNTIME_CHANNELS.bootstrap, {
    href: frame.location.href,
    isMainFrame: process.isMainFrame
  }) as unknown
  if (!isBootstrapResponse(response)) {
    return
  }

  for (const entry of response.entries) {
    installStrategy(entry)
  }
}

function installStrategy(entry: StrategyBootstrapEntry): void {
  const signal = (type: StrategyRuntimeSignalType, detail?: string): void => {
    ipcRenderer.send(STRATEGY_RUNTIME_CHANNELS.signal, {
      token: entry.token,
      type,
      ...(detail === undefined ? {} : { detail })
    })
  }

  try {
    contextBridge.exposeInIsolatedWorld(
      entry.worldId,
      '__agenticStrategyHost',
      {
        signal,
        invoke: (method: StrategyHostMethod, payload: unknown) =>
          ipcRenderer.invoke(STRATEGY_RUNTIME_CHANNELS.invoke, {
            token: entry.token,
            method,
            payload
          }),
        executeMainWorld: async (source: unknown) => {
          if (
            !entry.permissions.includes('main-world') ||
            typeof source !== 'string' ||
            source.length === 0 ||
            source.length > 64 * 1024
          ) {
            throw new Error('Strategy main-world 执行未授权或源码无效')
          }
          await ipcRenderer.invoke(STRATEGY_RUNTIME_CHANNELS.invoke, {
            token: entry.token,
            method: 'main-world-eval',
            payload: { sourceLength: source.length }
          })
          return webFrame.executeJavaScript(source, false)
        }
      }
    )

    void webFrame
      .executeJavaScriptInIsolatedWorld(entry.worldId, [
        { code: buildStrategySource(entry) }
      ])
      .then(() => signal('installed'))
      .catch((error: unknown) => {
        signal('failed', formatError(error))
      })
  } catch (error) {
    signal('failed', formatError(error))
  }
}

function buildStrategySource(entry: StrategyBootstrapEntry): string {
  const sourceUrl = `agentic-strategy://${entry.strategyId}/${entry.version}.js`
  return `
(() => {
  'use strict'
  const host = globalThis.__agenticStrategyHost
  const deepFreeze = (value) => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value)
      for (const child of Object.values(value)) deepFreeze(child)
    }
    return value
  }
  const serializeError = (error) => {
    try {
      if (error instanceof Error) {
        return String(error.stack || error.message).slice(0, 4000)
      }
      return String(error).slice(0, 4000)
    } catch {
      return '无法序列化 Strategy 错误'
    }
  }
  const invoke = (method, payload) => host.invoke(method, payload)
  const agenticStrategy = Object.freeze({
    config: deepFreeze(${JSON.stringify(entry.config)}),
    log: (message, data) =>
      invoke(
        'log',
        data === undefined
          ? { level: 'info', message: String(message) }
          : { level: 'info', message: String(message), data }
      ),
    debug: (message, data) =>
      invoke(
        'log',
        data === undefined
          ? { level: 'debug', message: String(message) }
          : { level: 'debug', message: String(message), data }
      ),
    warn: (message, data) =>
      invoke(
        'log',
        data === undefined
          ? { level: 'warn', message: String(message) }
          : { level: 'warn', message: String(message), data }
      ),
    error: (message, data) =>
      invoke(
        'log',
        data === undefined
          ? { level: 'error', message: String(message) }
          : { level: 'error', message: String(message), data }
      ),
    emit: (name, payload) =>
      invoke(
        'emit-event',
        payload === undefined
          ? { name: String(name) }
          : { name: String(name), payload }
      ),
    request: (request) => invoke('network-request', request),
    evaluateMainWorld: (source) => host.executeMainWorld(source)
  })
  const run = async () => {
    host.signal('started')
    const heartbeat = globalThis.setInterval(
      () => host.signal('heartbeat'),
      ${Math.max(250, Math.floor(entry.heartbeatMs / 3))}
    )
    try {
      await (async (agenticStrategy) => {
${entry.source}
      })(agenticStrategy)
      host.signal('ready')
    } catch (error) {
      globalThis.clearInterval(heartbeat)
      host.signal('failed', serializeError(error))
    }
  }
  const launchWhenIdle = () => {
    if (typeof globalThis.requestIdleCallback === 'function') {
      globalThis.requestIdleCallback(() => void run(), { timeout: 1000 })
    } else {
      globalThis.setTimeout(() => void run(), 0)
    }
  }
  if (${JSON.stringify(entry.runAt)} === 'document-start') {
    void run()
  } else if (${JSON.stringify(entry.runAt)} === 'document-end') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => void run(), {
        once: true
      })
    } else {
      globalThis.queueMicrotask(() => void run())
    }
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', launchWhenIdle, {
      once: true
    })
  } else {
    launchWhenIdle()
  }
})()
//# sourceURL=${sourceUrl}
`
}

function isBootstrapResponse(
  value: unknown
): value is StrategyBootstrapResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'entries' in value &&
    Array.isArray(value.entries) &&
    value.entries.length <= 256 &&
    value.entries.every(isBootstrapEntry)
  )
}

function isBootstrapEntry(value: unknown): value is StrategyBootstrapEntry {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const entry = value as Partial<StrategyBootstrapEntry>
  return (
    typeof entry.token === 'string' &&
    entry.token.length >= 16 &&
    typeof entry.worldId === 'number' &&
    Number.isInteger(entry.worldId) &&
    entry.worldId >= 1_001 &&
    typeof entry.strategyId === 'string' &&
    typeof entry.version === 'string' &&
    (entry.runAt === 'document-start' ||
      entry.runAt === 'document-end' ||
      entry.runAt === 'document-idle') &&
    Array.isArray(entry.permissions) &&
    entry.permissions.every((permission) => typeof permission === 'string') &&
    typeof entry.source === 'string' &&
    typeof entry.config === 'object' &&
    entry.config !== null &&
    typeof entry.startupMs === 'number' &&
    typeof entry.heartbeatMs === 'number'
  )
}

function formatError(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? error.message).slice(0, 4_000)
    : String(error).slice(0, 4_000)
}
