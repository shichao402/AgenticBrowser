import type { PageHealthSnapshot } from '../shared/contracts'

export interface HealthMonitorOptions {
  intervalMs: number
  timeoutMs: number
  failureThreshold: number
}

const DEFAULT_OPTIONS: HealthMonitorOptions = {
  intervalMs: 1_000,
  timeoutMs: 500,
  failureThreshold: 3
}

export class HealthMonitor {
  private timer: NodeJS.Timeout | null = null
  private checkInFlight: Promise<void> | null = null
  private unhealthyNotified = false
  private snapshot: PageHealthSnapshot = {
    status: 'stopped',
    lastProbeAt: null,
    lastResponseAt: null,
    consecutiveFailures: 0
  }

  constructor(
    private readonly probe: () => Promise<boolean>,
    private readonly onChange: (snapshot: PageHealthSnapshot) => void,
    private readonly onUnhealthy: (snapshot: PageHealthSnapshot) => void | Promise<void>,
    private readonly options: HealthMonitorOptions = DEFAULT_OPTIONS
  ) {
    if (
      options.intervalMs <= 0 ||
      options.timeoutMs <= 0 ||
      !Number.isInteger(options.failureThreshold) ||
      options.failureThreshold <= 0
    ) {
      throw new Error('HealthMonitor 配置无效')
    }
  }

  start(): void {
    if (this.timer) {
      return
    }

    this.update({
      ...this.snapshot,
      status: 'starting'
    })
    void this.checkNow()
    this.timer = setInterval(() => {
      void this.checkNow()
    }, this.options.intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.update({
      ...this.snapshot,
      status: 'stopped'
    })
  }

  getSnapshot(): PageHealthSnapshot {
    return { ...this.snapshot }
  }

  async checkNow(): Promise<void> {
    if (this.checkInFlight) {
      return this.checkInFlight
    }

    this.checkInFlight = this.runCheck().finally(() => {
      this.checkInFlight = null
    })
    return this.checkInFlight
  }

  private async runCheck(): Promise<void> {
    const now = new Date().toISOString()
    let timeout: NodeJS.Timeout
    const timeoutResult = new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), this.options.timeoutMs)
      timeout.unref()
    })
    const responsive = await Promise.race([
      this.probe().catch(() => false),
      timeoutResult
    ])
    clearTimeout(timeout!)

    if (responsive) {
      this.unhealthyNotified = false
      this.update({
        status: 'healthy',
        lastProbeAt: now,
        lastResponseAt: now,
        consecutiveFailures: 0
      })
      return
    }

    const consecutiveFailures = this.snapshot.consecutiveFailures + 1
    const next: PageHealthSnapshot = {
      ...this.snapshot,
      status:
        consecutiveFailures >= this.options.failureThreshold
          ? 'unresponsive'
          : 'degraded',
      lastProbeAt: now,
      consecutiveFailures
    }
    this.update(next)

    if (
      consecutiveFailures >= this.options.failureThreshold &&
      !this.unhealthyNotified
    ) {
      this.unhealthyNotified = true
      await this.onUnhealthy(this.getSnapshot())
    }
  }

  private update(snapshot: PageHealthSnapshot): void {
    this.snapshot = snapshot
    this.onChange(this.getSnapshot())
  }
}
