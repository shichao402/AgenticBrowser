import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { create } from '@bufbuild/protobuf'

import type { UpdateOffer, UpdateStatus } from '../../shared/contracts'
import { UpdaterEngine, UpdaterError, type EngineConfig } from './engine'
import {
  ApplyDisposition,
  ClientProfileSchema,
  InstallSpecSchema,
  Placement,
  RecoveryHelpSchema,
  RecoveryLinkSchema,
  RuntimeSchema,
  SessionPhase,
  type CheckResult,
  type UpdateAvailable
} from './gen/updater/v2/updater_pb'
import type { ReleaseIdentity } from './identity'
import { describeError, locationProblem, type InstallLayout } from './layout'

// 应用内更新的状态机。协议行为（验签、防回滚、选版本、校验、安装）全在
// relkit-updater 里，这里只做三件事：把本机事实交给引擎、把结果收敛成
// UpdateStatus、决定什么时候检查。多写一行“顺手比较版本”就是开了第二个
// 真相源。

export const RELEASES_URL =
  'https://github.com/shichao402/AgenticBrowser/releases'

export const NOT_INTEGRATED_MESSAGE =
  '此构建未接入更新（只有 CI 发布构建启用自动更新）。'

export const FIRST_CHECK_DELAY_MS = 60_000
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
export const PROGRESS_THROTTLE_MS = 250

const REPORTED_SESSION_FILE = 'reported-session'

export type EngineLike = Pick<
  UpdaterEngine,
  'status' | 'check' | 'download' | 'apply'
>

export type Schedule = (callback: () => void, delayMs: number) => () => void

const defaultSchedule: Schedule = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs)
  timer.unref()
  return () => clearTimeout(timer)
}

export interface UpdateServiceOptions {
  identity: ReleaseIdentity | null
  layout: InstallLayout | null
  /** os-arch 选择器；本机没有对应产物时为 null。 */
  selector: string | null
  /** 引擎状态目录，放在用户数据目录里，不在安装树里。 */
  dataDir: string
  displayName: string
  /** 未接入构建显示用的版本号（app.getVersion()）。 */
  fallbackVersion: string
  quit: () => void
  isWritable: (directory: string) => boolean
  fileExists?: (path: string) => boolean
  createEngine?: (config: EngineConfig) => EngineLike
  schedule?: Schedule
  now?: () => number
  log?: (message: string) => void
}

type Listener = (status: UpdateStatus) => void

function toOffer(update: UpdateAvailable): UpdateOffer {
  const size = update.artifacts.reduce(
    (sum, artifact) => sum + Number(artifact.size),
    0
  )
  return {
    version: update.version,
    code: Number(update.code),
    mandatory: update.mandatory,
    inApp:
      update.applyDisposition === ApplyDisposition.INTERNAL ||
      update.applyDisposition === ApplyDisposition.FULL_INSTALL,
    fullInstall: update.applyDisposition === ApplyDisposition.FULL_INSTALL,
    releaseNotes: update.releaseNotesMarkdown,
    releaseNotesUrl:
      update.releaseNotesUrl.length > 0 ? update.releaseNotesUrl : null,
    sizeBytes: size
  }
}

export class UpdateService {
  private readonly options: UpdateServiceOptions
  private readonly engine: EngineLike | null
  private readonly schedule: Schedule
  private readonly now: () => number
  private readonly listeners = new Set<Listener>()
  private status: UpdateStatus
  private planId: string | null = null
  private busy = false
  private cancelTimer: (() => void) | null = null
  private lastProgressAt = 0

  constructor(options: UpdateServiceOptions) {
    this.options = options
    this.schedule = options.schedule ?? defaultSchedule
    this.now = options.now ?? Date.now
    const { identity } = options
    const disabledReason = this.disabledReason()
    this.engine =
      disabledReason === null && identity && options.layout && options.selector
        ? (options.createEngine ?? ((config) => new UpdaterEngine(config)))(
            this.engineConfig(identity, options.layout, options.selector)
          )
        : null
    this.status = {
      enabled: this.engine !== null,
      channel: identity?.channel ?? null,
      currentVersion: identity?.version ?? options.fallbackVersion,
      currentCode: identity ? Number(identity.code) : null,
      phase: this.engine ? 'idle' : 'disabled',
      message: disabledReason,
      available: null,
      progress: null,
      manualUrl: null,
      checkedAt: null
    }
  }

  private disabledReason(): string | null {
    const { identity, layout, selector } = this.options
    if (!identity) return NOT_INTEGRATED_MESSAGE
    if (!selector) return '当前系统或架构没有发布更新包，应用内更新不可用。'
    if (!layout) return '无法识别安装位置，应用内更新不可用。'
    const exists = this.options.fileExists ?? existsSync
    if (!exists(layout.sidecarPath)) {
      return '安装包缺少更新组件，请重新下载安装程序。'
    }
    return locationProblem(layout, this.options.isWritable)
  }

  private engineConfig(
    identity: ReleaseIdentity,
    layout: InstallLayout,
    selector: string
  ): EngineConfig {
    return {
      bin: layout.sidecarPath,
      profile: create(ClientProfileSchema, {
        bootstrap: identity.bootstrap,
        expectedProduct: identity.product,
        recovery: create(RecoveryHelpSchema, {
          message: '自动更新失败时，可以到发布页下载安装程序手动更新。',
          links: [
            create(RecoveryLinkSchema, { label: '发布页', url: RELEASES_URL })
          ]
        })
      }),
      runtime: create(RuntimeSchema, {
        channel: identity.channel,
        currentCode: identity.code,
        clientSelectors: { 'os-arch': selector },
        dataDir: this.options.dataDir,
        install: create(InstallSpecSchema, {
          placement: Placement.IN_PLACE,
          installRoot: layout.installRoot,
          executableRelpath: layout.executableRelpath,
          sidecarRelpath: layout.sidecarRelpath,
          preserve: layout.preserve,
          relaunch: true,
          displayName: this.options.displayName
        })
      })
    }
  }

  getStatus(): UpdateStatus {
    return { ...this.status }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private update(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch }
    const snapshot = this.getStatus()
    for (const listener of this.listeners) {
      listener(snapshot)
    }
  }

  private log(message: string): void {
    this.options.log?.(message)
  }

  private fail(error: unknown, extra: Partial<UpdateStatus> = {}): void {
    if (error instanceof UpdaterError) {
      this.log(
        `[updater] ${error.code}: ${error.message} ${error.attempts.join(' | ')}`
      )
      this.update({
        phase: 'error',
        message: describeError(error.code, error.message),
        progress: null,
        ...extra
      })
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    this.log(`[updater] ${message}`)
    this.update({
      phase: 'error',
      message: `更新失败：${message}`,
      progress: null,
      ...extra
    })
  }

  /**
   * 启动交接：引擎说它的安装进程还握着安装根时，新起的这一份必须让位。
   * 问不到一律放行，崩掉的更新不能把用户挡在门外。
   */
  async hostMustExit(): Promise<boolean> {
    if (!this.engine) return false
    try {
      return (await this.engine.status()).hostMustExit
    } catch (error) {
      this.log(`[updater] 询问启动交接失败，按正常启动继续：${String(error)}`)
      return false
    }
  }

  /** 开始定时检查；未接入时什么都不做。 */
  start(): void {
    if (!this.engine || this.cancelTimer) return
    void this.reportLastSession()
    this.scheduleNext(FIRST_CHECK_DELAY_MS)
  }

  stop(): void {
    this.cancelTimer?.()
    this.cancelTimer = null
  }

  private scheduleNext(delayMs: number): void {
    this.cancelTimer = this.schedule(() => {
      void this.check({ manual: false }).finally(() => {
        if (this.cancelTimer) this.scheduleNext(CHECK_INTERVAL_MS)
      })
    }, delayMs)
  }

  private readReportedSession(): string {
    try {
      return readFileSync(
        join(this.options.dataDir, REPORTED_SESSION_FILE),
        'utf8'
      ).trim()
    } catch {
      return ''
    }
  }

  private writeReportedSession(sessionId: string): void {
    try {
      mkdirSync(this.options.dataDir, { recursive: true })
      writeFileSync(
        join(this.options.dataDir, REPORTED_SESSION_FILE),
        sessionId
      )
    } catch (error) {
      this.log(`[updater] 记录已提示会话失败：${String(error)}`)
    }
  }

  /** 上次安装回滚或需要人工处理时提示一次；同一会话不重复提示。 */
  async reportLastSession(): Promise<void> {
    if (!this.engine) return
    try {
      const snapshot = await this.engine.status()
      const session = snapshot.activeSession
      if (!session) return
      const rolledBack = session.phase === SessionPhase.ROLLED_BACK
      if (!rolledBack && session.phase !== SessionPhase.NEEDS_ATTENTION) return
      if (session.sessionId === this.readReportedSession()) return
      this.writeReportedSession(session.sessionId)
      if (this.busy || this.status.phase !== 'idle') return
      const detail = session.error
        ? describeError(session.error.code, session.error.message)
        : ''
      this.update({
        phase: 'error',
        message: rolledBack
          ? `上次更新没有成功，已回滚到当前版本。${detail}`
          : `上次更新没有完成，安装目录可能需要人工处理，建议重新下载安装程序。${detail}`,
        manualUrl: RELEASES_URL
      })
    } catch (error) {
      this.log(`[updater] 读取上次安装结果失败（忽略）：${String(error)}`)
    }
  }

  /** manual 为 true 时跳过引擎节流（用户点了“检查更新”）。 */
  async check({ manual }: { manual: boolean }): Promise<UpdateStatus> {
    const engine = this.engine
    if (!engine || this.busy) return this.getStatus()
    const phase = this.status.phase
    if (!manual && (phase === 'downloaded' || phase === 'available')) {
      return this.getStatus()
    }
    this.busy = true
    const previous = this.getStatus()
    this.update({ phase: 'checking', message: null, progress: null })
    try {
      this.applyCheckResult(await engine.check(manual), previous, manual)
    } catch (error) {
      this.fail(error, { available: null, manualUrl: null })
      this.planId = null
    } finally {
      this.busy = false
    }
    return this.getStatus()
  }

  private applyCheckResult(
    result: CheckResult,
    previous: UpdateStatus,
    manual: boolean
  ): void {
    const checkedAt = new Date(this.now()).toISOString()
    switch (result.kind.case) {
      case 'upToDate':
        this.planId = null
        this.update({
          phase: 'up-to-date',
          message: result.kind.value.currentIsYanked
            ? '当前版本已被撤回，请留意后续更新。'
            : null,
          available: null,
          manualUrl: null,
          checkedAt
        })
        return
      case 'updateAvailable': {
        const offer = toOffer(result.kind.value)
        this.planId = result.kind.value.planId
        this.log(`[updater] 发现新版本 ${offer.version}（code ${offer.code}）`)
        this.update({
          phase: 'available',
          message: offer.inApp ? null : '这个版本需要到发布页下载安装程序。',
          available: offer,
          manualUrl: offer.inApp ? null : RELEASES_URL,
          checkedAt
        })
        return
      }
      case 'fallbackRequired': {
        const fallback = result.kind.value
        this.planId = null
        this.update({
          phase: 'fallback',
          message:
            fallback.message.length > 0
              ? fallback.message
              : '需要下载安装程序手动更新。',
          available: null,
          manualUrl:
            fallback.manualUrl.length > 0 ? fallback.manualUrl : RELEASES_URL,
          checkedAt
        })
        return
      }
      case 'throttled':
        this.update({
          phase: previous.phase === 'checking' ? 'idle' : previous.phase,
          message: manual ? '检查过于频繁，请稍后再试。' : previous.message
        })
        return
      default:
        this.update({
          phase: 'error',
          message: '更新组件返回了无法识别的检查结果。'
        })
    }
  }

  async download(): Promise<UpdateStatus> {
    const engine = this.engine
    const planId = this.planId
    const offer = this.status.available
    if (!engine || this.busy || !planId || !offer?.inApp)
      return this.getStatus()
    if (this.status.phase === 'downloaded') return this.getStatus()
    this.busy = true
    this.lastProgressAt = 0
    this.update({
      phase: 'downloading',
      message: null,
      progress: { received: 0, total: offer.sizeBytes, bytesPerSecond: 0 }
    })
    try {
      await engine.download(planId, (progress) => {
        const received = Number(progress.bytesReceived)
        const total = Number(progress.bytesTotal)
        const now = this.now()
        if (
          now - this.lastProgressAt < PROGRESS_THROTTLE_MS &&
          received < total
        )
          return
        this.lastProgressAt = now
        this.update({
          progress: {
            received,
            total,
            bytesPerSecond: Number(progress.bytesPerSecond)
          }
        })
      })
      this.update({ phase: 'downloaded', message: null, progress: null })
    } catch (error) {
      this.fail(error)
    } finally {
      this.busy = false
    }
    return this.getStatus()
  }

  async install(): Promise<UpdateStatus> {
    const engine = this.engine
    const planId = this.planId
    if (!engine || this.busy || !planId || this.status.phase !== 'downloaded') {
      return this.getStatus()
    }
    this.busy = true
    this.update({
      phase: 'applying',
      message: '正在交给更新程序安装，应用即将退出并自动重启…'
    })
    try {
      const accepted = await engine.apply(planId)
      if (accepted.requiresHostExit) {
        this.stop()
        this.log(`[updater] 安装会话 ${accepted.sessionId} 已接管，宿主退出`)
        this.options.quit()
      } else {
        this.update({ message: '更新已安装，重启应用后生效。' })
      }
    } catch (error) {
      this.fail(error)
    } finally {
      this.busy = false
    }
    return this.getStatus()
  }
}
