import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { PassThrough } from 'node:stream'

import { create, fromJsonString, toJsonString } from '@bufbuild/protobuf'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  UPDATER_PROTOCOL,
  UpdaterEngine,
  UpdaterError,
  checkHandshake,
  decodeEvent,
  terminalEvent,
  type EngineProcess,
  type EngineSpawn
} from '../src/main/updater/engine'
import {
  ApplyAcceptedSchema,
  ApplyResultSchema,
  CapabilitiesSchema,
  CheckResultSchema,
  ClientProfileSchema,
  DownloadResultSchema,
  DownloadedSchema,
  ErrorCode,
  ErrorSchema,
  FailedSchema,
  LogSchema,
  ProgressSchema,
  RuntimeSchema,
  StatusSnapshotSchema,
  ThrottledSchema,
  UpToDateSchema,
  UpdaterEventSchema,
  UpdaterRequestSchema,
  type UpdaterEvent
} from '../src/main/updater/gen/updater/v2/updater_pb'

type Kind = UpdaterEvent['kind']

function event(kind: Kind): UpdaterEvent {
  return create(UpdaterEventSchema, { kind })
}

function line(kind: Kind): string {
  return toJsonString(UpdaterEventSchema, event(kind))
}

function capabilities(protocol = UPDATER_PROTOCOL): string {
  return line({
    case: 'capabilities',
    value: create(CapabilitiesSchema, { protocol })
  })
}

function engineError(code: ErrorCode, message: string) {
  return create(ErrorSchema, { code, message, attempts: ['a1'] })
}

class FakeProcess extends EventEmitter implements EngineProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  request = ''
  killed = false
  private closed = false

  kill(): boolean {
    this.killed = true
    this.close(null)
    return true
  }

  close(code: number | null): void {
    if (this.closed) return
    this.closed = true
    this.stdout.end()
    this.stderr.end()
    this.stdout.once('end', () => this.emit('close', code))
    this.stdout.resume()
  }
}

type Script = (proc: FakeProcess) => void

/** 每次 spawn 收齐 stdin 后执行脚本；脚本负责写 stdout 并 close。 */
function fakeSpawn(script: Script): {
  spawn: EngineSpawn
  procs: FakeProcess[]
} {
  const procs: FakeProcess[] = []
  const spawn: EngineSpawn = () => {
    const proc = new FakeProcess()
    procs.push(proc)
    proc.stdin.setEncoding('utf8')
    proc.stdin.on('data', (chunk: string) => {
      proc.request += chunk
    })
    proc.stdin.on('end', () => script(proc))
    return proc
  }
  return { spawn, procs }
}

function respond(lines: string[], code = 0, stderr = ''): Script {
  return (proc) => {
    if (stderr) proc.stderr.write(stderr)
    // 故意拆成跨行的碎片，验证按行缓冲。
    const text = lines.map((entry) => `${entry}\n`).join('')
    const middle = Math.floor(text.length / 2)
    proc.stdout.write(text.slice(0, middle))
    proc.stdout.write(text.slice(middle))
    proc.close(code)
  }
}

function makeEngine(spawn: EngineSpawn): UpdaterEngine {
  return new UpdaterEngine({
    bin: '/x/relkit-updater',
    profile: create(ClientProfileSchema, {
      bootstrap: 'b',
      expectedProduct: 'AgenticBrowser'
    }),
    runtime: create(RuntimeSchema, {
      channel: 'dev',
      currentCode: 7n,
      dataDir: '/d'
    }),
    spawn
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('decodeEvent / checkHandshake / terminalEvent', () => {
  it('decodes a valid event and rejects unknown fields', () => {
    expect(decodeEvent(capabilities()).kind.case).toBe('capabilities')
    expect(() =>
      decodeEvent('{"capabilities":{"protocol":5,"bogus":1}}')
    ).toThrow(UpdaterError)
    expect(() => decodeEvent('not json')).toThrow(/契约/)
  })

  it('checks the protocol in both directions', () => {
    const at = (protocol: number): UpdaterEvent =>
      decodeEvent(capabilities(protocol))
    expect(() => checkHandshake(at(UPDATER_PROTOCOL))).not.toThrow()
    expect(() => checkHandshake(at(UPDATER_PROTOCOL - 1))).toThrow(
      expect.objectContaining({ code: ErrorCode.UPDATER_TOO_OLD })
    )
    expect(() => checkHandshake(at(UPDATER_PROTOCOL + 1))).toThrow(
      expect.objectContaining({ code: ErrorCode.UPDATER_TOO_NEW })
    )
    expect(() =>
      checkHandshake(
        event({ case: 'log', value: create(LogSchema, { message: 'x' }) })
      )
    ).toThrow(expect.objectContaining({ code: ErrorCode.PROTOCOL_MISMATCH }))
  })

  it('prefers a top-level failure and otherwise the last non-streaming event', () => {
    const status = event({
      case: 'status',
      value: create(StatusSnapshotSchema, {})
    })
    const log = event({
      case: 'log',
      value: create(LogSchema, { message: 'x' })
    })
    expect(terminalEvent([decodeEvent(capabilities()), status, log])).toBe(
      status
    )
    expect(() =>
      terminalEvent([
        status,
        event({
          case: 'failed',
          value: create(FailedSchema, {
            error: engineError(ErrorCode.DISK, 'full')
          })
        })
      ])
    ).toThrow(
      expect.objectContaining({ code: ErrorCode.DISK, attempts: ['a1'] })
    )
    expect(() =>
      terminalEvent([event({ case: 'failed', value: create(FailedSchema) })])
    ).toThrow(expect.objectContaining({ code: ErrorCode.UNSPECIFIED }))
    expect(() => terminalEvent([decodeEvent(capabilities()), log])).toThrow(
      /没有返回结果/
    )
  })
})

describe('UpdaterEngine', () => {
  it('sends a strict request and returns the status snapshot', async () => {
    const { spawn, procs } = fakeSpawn(
      respond([
        capabilities(),
        line({
          case: 'status',
          value: create(StatusSnapshotSchema, { hostMustExit: true })
        })
      ])
    )
    const snapshot = await makeEngine(spawn).status()
    expect(snapshot.hostMustExit).toBe(true)
    const request = fromJsonString(
      UpdaterRequestSchema,
      procs[0]?.request.trim() ?? ''
    )
    expect(request.protocol).toBe(UPDATER_PROTOCOL)
    expect(request.op.case).toBe('status')
    expect(request.runtime?.currentCode).toBe(7n)
    expect(request.profile?.expectedProduct).toBe('AgenticBrowser')
  })

  it('returns check results and throws on check failures', async () => {
    const upToDate = fakeSpawn(
      respond([
        capabilities(),
        line({
          case: 'check',
          value: create(CheckResultSchema, {
            kind: { case: 'upToDate', value: create(UpToDateSchema, {}) }
          })
        })
      ])
    )
    expect((await makeEngine(upToDate.spawn).check(true)).kind.case).toBe(
      'upToDate'
    )
    const request = fromJsonString(
      UpdaterRequestSchema,
      upToDate.procs[0]?.request.trim() ?? ''
    )
    expect(request.op.case === 'check' && request.op.value.force).toBe(true)

    const failed = fakeSpawn(
      respond([
        capabilities(),
        line({
          case: 'check',
          value: create(CheckResultSchema, {
            kind: {
              case: 'failed',
              value: create(FailedSchema, {
                error: engineError(ErrorCode.NETWORK, 'offline')
              })
            }
          })
        })
      ])
    )
    await expect(makeEngine(failed.spawn).check(false)).rejects.toMatchObject({
      code: ErrorCode.NETWORK
    })

    const empty = fakeSpawn(
      respond([
        capabilities(),
        line({ case: 'check', value: create(CheckResultSchema, {}) })
      ])
    )
    await expect(makeEngine(empty.spawn).check(false)).rejects.toThrow(
      /意外的事件/
    )

    const throttled = fakeSpawn(
      respond([
        capabilities(),
        line({
          case: 'check',
          value: create(CheckResultSchema, {
            kind: { case: 'throttled', value: create(ThrottledSchema, {}) }
          })
        })
      ])
    )
    expect((await makeEngine(throttled.spawn).check(false)).kind.case).toBe(
      'throttled'
    )
  })

  it('streams download progress and returns the downloaded plan', async () => {
    const progress = (received: bigint): string =>
      line({
        case: 'progress',
        value: create(ProgressSchema, {
          bytesReceived: received,
          bytesTotal: 10n
        })
      })
    const { spawn } = fakeSpawn(
      respond([
        capabilities(),
        progress(4n),
        progress(10n),
        line({
          case: 'download',
          value: create(DownloadResultSchema, {
            kind: {
              case: 'downloaded',
              value: create(DownloadedSchema, { planId: 'p1', bytes: 10n })
            }
          })
        })
      ])
    )
    const seen: bigint[] = []
    const downloaded = await makeEngine(spawn).download('p1', (p) =>
      seen.push(p.bytesReceived)
    )
    expect(downloaded.planId).toBe('p1')
    expect(seen).toEqual([4n, 10n])
  })

  it('surfaces download and apply failures', async () => {
    const downloadFailed = fakeSpawn(
      respond([
        capabilities(),
        line({
          case: 'download',
          value: create(DownloadResultSchema, {
            kind: {
              case: 'failed',
              value: create(FailedSchema, {
                error: engineError(ErrorCode.SIGNATURE, 'bad')
              })
            }
          })
        })
      ])
    )
    await expect(
      makeEngine(downloadFailed.spawn).download('p1')
    ).rejects.toMatchObject({
      code: ErrorCode.SIGNATURE
    })

    const applyFailed = fakeSpawn(
      respond([
        capabilities(),
        line({
          case: 'apply',
          value: create(ApplyResultSchema, {
            kind: {
              case: 'failed',
              value: create(FailedSchema, {
                error: engineError(ErrorCode.OCCUPIED, 'busy')
              })
            }
          })
        })
      ])
    )
    await expect(
      makeEngine(applyFailed.spawn).apply('p1')
    ).rejects.toMatchObject({
      code: ErrorCode.OCCUPIED
    })
  })

  it('returns the accepted apply session', async () => {
    const { spawn } = fakeSpawn(
      respond([
        capabilities(),
        line({
          case: 'apply',
          value: create(ApplyResultSchema, {
            kind: {
              case: 'accepted',
              value: create(ApplyAcceptedSchema, {
                sessionId: 's1',
                requiresHostExit: true
              })
            }
          })
        })
      ])
    )
    const accepted = await makeEngine(spawn).apply('p1')
    expect(accepted).toMatchObject({ sessionId: 's1', requiresHostExit: true })
  })

  it('rejects mismatched result kinds', async () => {
    const { spawn } = fakeSpawn(
      respond([
        capabilities(),
        line({ case: 'status', value: create(StatusSnapshotSchema, {}) })
      ])
    )
    const engine = makeEngine(spawn)
    await expect(engine.check(false)).rejects.toThrow(/意外的事件/)
    await expect(engine.download('p')).rejects.toThrow(/意外的事件/)
    await expect(engine.apply('p')).rejects.toThrow(/意外的事件/)
    const wrong = fakeSpawn(
      respond([
        capabilities(),
        line({ case: 'check', value: create(CheckResultSchema, {}) })
      ])
    )
    await expect(makeEngine(wrong.spawn).status()).rejects.toThrow(/意外的事件/)
  })

  it('kills the engine on a handshake mismatch', async () => {
    const { spawn, procs } = fakeSpawn((proc) => {
      proc.stdout.write(`${capabilities(UPDATER_PROTOCOL + 1)}\n`)
      // 不主动 close：宿主必须自己 kill。
    })
    await expect(makeEngine(spawn).status()).rejects.toMatchObject({
      code: ErrorCode.UPDATER_TOO_NEW
    })
    expect(procs[0]?.killed).toBe(true)
  })

  it('rejects contract drift in later lines', async () => {
    const { spawn } = fakeSpawn(
      respond([capabilities(), '{"status":{"surprise":true}}'])
    )
    await expect(makeEngine(spawn).status()).rejects.toMatchObject({
      code: ErrorCode.PROTOCOL_MISMATCH
    })
  })

  it('reports a bare non-zero exit with stderr', async () => {
    const { spawn } = fakeSpawn(respond([capabilities()], 2, 'boom'))
    await expect(makeEngine(spawn).status()).rejects.toThrow(/退出码 2：boom/)
  })

  it('trusts a structured result even when the exit code is non-zero', async () => {
    const { spawn } = fakeSpawn(
      respond(
        [
          capabilities(),
          line({ case: 'status', value: create(StatusSnapshotSchema, {}) })
        ],
        1
      )
    )
    await expect(makeEngine(spawn).status()).resolves.toBeDefined()
  })

  it('handles a final line without a trailing newline', async () => {
    const { spawn } = fakeSpawn((proc) => {
      proc.stdout.write(`${capabilities()}\n`)
      proc.stdout.write(
        line({ case: 'status', value: create(StatusSnapshotSchema, {}) })
      )
      proc.close(0)
    })
    await expect(makeEngine(spawn).status()).resolves.toBeDefined()
  })

  it('maps spawn failures to SIDECAR_NOT_FOUND', async () => {
    const throwing: EngineSpawn = () => {
      throw new Error('ENOENT')
    }
    await expect(makeEngine(throwing).status()).rejects.toMatchObject({
      code: ErrorCode.SIDECAR_NOT_FOUND
    })

    const emitting: EngineSpawn = () => {
      const proc = new FakeProcess()
      setImmediate(() => proc.emit('error', new Error('EACCES')))
      return proc
    }
    await expect(makeEngine(emitting).status()).rejects.toThrow(/EACCES/)
  })

  it('times out a silent engine', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { spawn, procs } = fakeSpawn(() => {
      // 引擎卡住：什么都不写。
    })
    const pending = makeEngine(spawn).status()
    const assertion = expect(pending).rejects.toThrow(/15 秒无响应/)
    await vi.waitFor(() => {
      expect(procs).toHaveLength(1)
    })
    // 等 stdin 的 end 事件被派发后再推进时间。
    await new Promise((resolve) => setImmediate(resolve))
    vi.advanceTimersByTime(15_000)
    await assertion
    expect(procs[0]?.killed).toBe(true)
  })
})

// 可选：与真实引擎往返一次，验证生成类型与引擎的线上形状一致。
// 设 RELKIT_UPDATER_BIN 指向本平台的 relkit-updater 时才跑。
const realBin = process.env.RELKIT_UPDATER_BIN
describe.skipIf(!realBin || !existsSync(realBin))('real relkit-updater', () => {
  it('completes the handshake and rejects an empty profile', async () => {
    const engine = new UpdaterEngine({
      bin: realBin ?? '',
      profile: create(ClientProfileSchema, {}),
      runtime: create(RuntimeSchema, {
        channel: 'dev',
        currentCode: 1n,
        dataDir: '/tmp/x'
      })
    })
    await expect(engine.status()).rejects.toMatchObject({
      code: ErrorCode.PROFILE_INVALID
    })
  })
})
