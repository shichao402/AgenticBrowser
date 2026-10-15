import { writeJsonAtomic } from './atomic-file'

export interface MainProcessHeartbeatRecord {
  schemaVersion: 1
  pid: number
  launchId: string
  restartCount: number
  timestamp: string
  uptimeMs: number
}

export class MainProcessHeartbeat {
  private timer: NodeJS.Timeout | null = null
  private pendingWrite: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(
    private readonly filePath: string,
    private readonly launchId: string,
    private readonly restartCount: number,
    private readonly intervalMs = 500
  ) {}

  start(): void {
    if (this.timer || this.stopped) {
      return
    }

    this.queuePulse()
    this.timer = setInterval(() => {
      this.queuePulse()
    }, this.intervalMs)
    this.timer.unref()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    await this.pendingWrite
  }

  private queuePulse(): void {
    if (this.stopped) {
      return
    }

    this.pendingWrite = this.pendingWrite
      .then(() =>
        writeJsonAtomic(this.filePath, {
          schemaVersion: 1,
          pid: process.pid,
          launchId: this.launchId,
          restartCount: this.restartCount,
          timestamp: new Date().toISOString(),
          uptimeMs: performance.now()
        } satisfies MainProcessHeartbeatRecord)
      )
      .catch((error: unknown) => {
        console.error('写入 main process heartbeat 失败', error)
      })
  }
}
