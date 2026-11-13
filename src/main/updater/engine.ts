import { spawn as spawnProcess } from 'node:child_process'

import { create, fromJsonString, toJsonString } from '@bufbuild/protobuf'

import {
  ApplyOpSchema,
  CheckOpSchema,
  DownloadOpSchema,
  ErrorCode,
  StatusOpSchema,
  UpdaterEventSchema,
  UpdaterRequestSchema,
  type ApplyAccepted,
  type CheckResult,
  type ClientProfile,
  type Downloaded,
  type Error as EngineErrorMessage,
  type Progress,
  type Runtime,
  type StatusSnapshot,
  type UpdaterEvent,
  type UpdaterRequest
} from './gen/updater/v2/updater_pb'

// relkit-updater 驱动（relkit ADR 0026，protocol 5）。
//
// 一次调用一个进程：stdin 写一个 ProtoJSON 的 UpdaterRequest 后关闭，stdout
// 每行一个 UpdaterEvent，首行固定是 Capabilities。两侧都严格解析，字段对不上
// 就是契约漂移，当场失败。宿主不解析 bootstrap、不验签、不比较版本。

export const UPDATER_PROTOCOL = 5

export class UpdaterError extends Error {
  readonly code: ErrorCode
  readonly attempts: readonly string[]

  constructor(
    code: ErrorCode,
    message: string,
    attempts: readonly string[] = []
  ) {
    super(message)
    this.name = 'UpdaterError'
    this.code = code
    this.attempts = attempts
  }
}

function fromEngineError(error: EngineErrorMessage | undefined): UpdaterError {
  if (!error) {
    return new UpdaterError(ErrorCode.UNSPECIFIED, '引擎回报失败但没有给出原因')
  }
  return new UpdaterError(error.code, error.message, error.attempts)
}

export interface EngineProcess {
  stdin: NodeJS.WritableStream
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  kill(): boolean
  once(event: 'close', listener: (code: number | null) => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
}

export type EngineSpawn = (bin: string, args: string[]) => EngineProcess

const defaultSpawn: EngineSpawn = (bin, args) =>
  spawnProcess(bin, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })

/** 严格解码一行 ProtoJSON；未知字段、类型不符都算契约漂移。 */
export function decodeEvent(line: string): UpdaterEvent {
  try {
    return fromJsonString(UpdaterEventSchema, line)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new UpdaterError(
      ErrorCode.PROTOCOL_MISMATCH,
      `无法解析引擎输出（契约不一致？）：${reason}`
    )
  }
}

/** 首行必须是 Capabilities 且协议号相等。 */
export function checkHandshake(first: UpdaterEvent): void {
  if (first.kind.case !== 'capabilities') {
    throw new UpdaterError(
      ErrorCode.PROTOCOL_MISMATCH,
      '引擎首行不是 Capabilities'
    )
  }
  const got = first.kind.value.protocol
  if (got < UPDATER_PROTOCOL) {
    throw new UpdaterError(
      ErrorCode.UPDATER_TOO_OLD,
      `relkit-updater 协议 ${got} 低于宿主要求的 ${UPDATER_PROTOCOL}`
    )
  }
  if (got > UPDATER_PROTOCOL) {
    throw new UpdaterError(
      ErrorCode.UPDATER_TOO_NEW,
      `relkit-updater 协议 ${got} 高于宿主支持的 ${UPDATER_PROTOCOL}`
    )
  }
}

const STREAMING_KINDS = new Set<UpdaterEvent['kind']['case']>([
  'capabilities',
  'progress',
  'applyProgress',
  'log',
  undefined
])

/** 取终止事件：顶层 Failed 优先，否则取最后一个非流式事件。 */
export function terminalEvent(events: readonly UpdaterEvent[]): UpdaterEvent {
  let last: UpdaterEvent | null = null
  for (const event of events) {
    if (event.kind.case === 'failed') {
      throw fromEngineError(event.kind.value.error)
    }
    if (!STREAMING_KINDS.has(event.kind.case)) {
      last = event
    }
  }
  if (!last) {
    throw new UpdaterError(ErrorCode.PROTOCOL_MISMATCH, '引擎没有返回结果')
  }
  return last
}

function unexpected(event: UpdaterEvent, operation: string): UpdaterError {
  return new UpdaterError(
    ErrorCode.PROTOCOL_MISMATCH,
    `引擎对 ${operation} 回了意外的事件：${event.kind.case ?? '空'}`
  )
}

export interface EngineConfig {
  bin: string
  profile: ClientProfile
  runtime: Runtime
  spawn?: EngineSpawn
}

type RequestOp = UpdaterRequest['op']

const STATUS_TIMEOUT_MS = 15_000
const CHECK_TIMEOUT_MS = 120_000
const APPLY_TIMEOUT_MS = 120_000

export class UpdaterEngine {
  private readonly bin: string
  private readonly profile: ClientProfile
  private readonly runtime: Runtime
  private readonly spawn: EngineSpawn

  constructor(config: EngineConfig) {
    this.bin = config.bin
    this.profile = config.profile
    this.runtime = config.runtime
    this.spawn = config.spawn ?? defaultSpawn
  }

  async status(): Promise<StatusSnapshot> {
    const event = await this.terminal(
      { case: 'status', value: create(StatusOpSchema) },
      STATUS_TIMEOUT_MS
    )
    if (event.kind.case === 'status') return event.kind.value
    throw unexpected(event, 'status')
  }

  /** 返回的 CheckResult 不会是 failed：失败一律抛 UpdaterError。 */
  async check(force: boolean): Promise<CheckResult> {
    const event = await this.terminal(
      { case: 'check', value: create(CheckOpSchema, { force }) },
      CHECK_TIMEOUT_MS
    )
    if (event.kind.case !== 'check') throw unexpected(event, 'check')
    const result = event.kind.value
    if (result.kind.case === 'failed')
      throw fromEngineError(result.kind.value.error)
    if (result.kind.case === undefined) throw unexpected(event, 'check')
    return result
  }

  async download(
    planId: string,
    onProgress?: (progress: Progress) => void
  ): Promise<Downloaded> {
    const event = await this.terminal(
      { case: 'download', value: create(DownloadOpSchema, { planId }) },
      0,
      (streamed) => {
        if (streamed.kind.case === 'progress') onProgress?.(streamed.kind.value)
      }
    )
    if (event.kind.case !== 'download') throw unexpected(event, 'download')
    const result = event.kind.value
    if (result.kind.case === 'failed')
      throw fromEngineError(result.kind.value.error)
    if (result.kind.case !== 'downloaded') throw unexpected(event, 'download')
    return result.kind.value
  }

  /** 进度窗口由引擎自己显示（hide_progress 恒为 false）。 */
  async apply(planId: string): Promise<ApplyAccepted> {
    const event = await this.terminal(
      { case: 'apply', value: create(ApplyOpSchema, { planId }) },
      APPLY_TIMEOUT_MS
    )
    if (event.kind.case !== 'apply') throw unexpected(event, 'apply')
    const result = event.kind.value
    if (result.kind.case === 'failed')
      throw fromEngineError(result.kind.value.error)
    if (result.kind.case !== 'accepted') throw unexpected(event, 'apply')
    return result.kind.value
  }

  /** 编码完整请求；导出给测试核对线上形状。 */
  encodeRequest(op: RequestOp): string {
    return toJsonString(
      UpdaterRequestSchema,
      create(UpdaterRequestSchema, {
        protocol: UPDATER_PROTOCOL,
        profile: this.profile,
        runtime: this.runtime,
        op
      })
    )
  }

  private async terminal(
    op: RequestOp,
    timeoutMs: number,
    onEvent?: (event: UpdaterEvent) => void
  ): Promise<UpdaterEvent> {
    const events = await this.run(this.encodeRequest(op), timeoutMs, onEvent)
    return terminalEvent(events)
  }

  private run(
    request: string,
    timeoutMs: number,
    onEvent?: (event: UpdaterEvent) => void
  ): Promise<UpdaterEvent[]> {
    return new Promise((resolve, reject) => {
      let child: EngineProcess
      try {
        child = this.spawn(this.bin, [])
      } catch (error) {
        reject(
          new UpdaterError(
            ErrorCode.SIDECAR_NOT_FOUND,
            `无法启动 relkit-updater：${error instanceof Error ? error.message : String(error)}`
          )
        )
        return
      }

      const events: UpdaterEvent[] = []
      let failure: UpdaterError | null = null
      let buffer = ''
      let stderr = ''
      let settled = false
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              failure ??= new UpdaterError(
                ErrorCode.UNSPECIFIED,
                `更新组件 ${Math.round(timeoutMs / 1000)} 秒无响应`
              )
              child.kill()
            }, timeoutMs)
          : null

      const finish = (outcome: () => void): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        outcome()
      }

      const handleLine = (line: string): void => {
        if (failure || line.trim().length === 0) return
        try {
          const event = decodeEvent(line)
          if (events.length === 0) checkHandshake(event)
          events.push(event)
          onEvent?.(event)
        } catch (error) {
          failure =
            error instanceof UpdaterError
              ? error
              : new UpdaterError(ErrorCode.PROTOCOL_MISMATCH, String(error))
          child.kill()
        }
      }

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          handleLine(buffer.slice(0, newline))
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf('\n')
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < 8192) stderr += chunk
      })

      child.once('error', (error) => {
        finish(() =>
          reject(
            new UpdaterError(
              ErrorCode.SIDECAR_NOT_FOUND,
              `无法启动 relkit-updater：${error.message}`
            )
          )
        )
      })
      child.once('close', (code) => {
        handleLine(buffer)
        buffer = ''
        finish(() => {
          if (failure) {
            reject(failure)
            return
          }
          // 非零退出但已写出结构化结果时，以结果为准。
          if (events.length <= 1 && code !== 0) {
            const detail = stderr.trim()
            reject(
              new UpdaterError(
                ErrorCode.PROTOCOL_MISMATCH,
                `relkit-updater 退出码 ${String(code)}${detail ? `：${detail}` : ''}`
              )
            )
            return
          }
          resolve(events)
        })
      })

      // 引擎读到 EOF 才开始处理，写完必须关。
      child.stdin.on('error', () => {
        // 引擎提前退出时写入会 EPIPE，结果以 close 为准。
      })
      child.stdin.end(`${request}\n`)
    })
  }
}
