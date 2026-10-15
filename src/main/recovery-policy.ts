export type RecoveryAction =
  | 'reload'
  | 'reload-ignore-cache'
  | 'clear-cache-and-reload'
  | 'recreate-view'
  | 'open-circuit'

export interface RecoveryDecision {
  action: RecoveryAction
  attempt: number
  delayMs: number
  reason: string
}

export interface RecoveryPolicyOptions {
  maxAttempts: number
  windowMs: number
  baseDelayMs: number
  maximumDelayMs: number
}

const DEFAULT_OPTIONS: RecoveryPolicyOptions = {
  maxAttempts: 4,
  windowMs: 60_000,
  baseDelayMs: 250,
  maximumDelayMs: 5_000
}

const ACTION_ORDER: Exclude<RecoveryAction, 'open-circuit'>[] = [
  'reload',
  'reload-ignore-cache',
  'clear-cache-and-reload',
  'recreate-view'
]

export class RecoveryPolicy {
  private readonly failures: number[] = []

  constructor(private readonly options: RecoveryPolicyOptions = DEFAULT_OPTIONS) {
    if (!Number.isInteger(options.maxAttempts) || options.maxAttempts <= 0) {
      throw new Error('maxAttempts 必须是正整数')
    }
    if (options.windowMs <= 0 || options.baseDelayMs < 0 || options.maximumDelayMs < 0) {
      throw new Error('Recovery 时间配置无效')
    }
  }

  next(
    reason: string,
    now = Date.now(),
    minimumAction?: Exclude<RecoveryAction, 'open-circuit'>
  ): RecoveryDecision {
    this.prune(now)
    const attempt = this.failures.length + 1

    if (attempt > this.options.maxAttempts) {
      return {
        action: 'open-circuit',
        attempt,
        delayMs: 0,
        reason
      }
    }

    this.failures.push(now)
    const defaultAction =
      ACTION_ORDER[Math.min(attempt - 1, ACTION_ORDER.length - 1)] ??
      'recreate-view'
    const action = minimumAction
      ? laterAction(defaultAction, minimumAction)
      : defaultAction
    const delayMs = Math.min(
      this.options.maximumDelayMs,
      this.options.baseDelayMs * 2 ** (attempt - 1)
    )

    return {
      action,
      attempt,
      delayMs,
      reason
    }
  }

  getAttempts(now = Date.now()): number {
    this.prune(now)
    return this.failures.length
  }

  reset(): void {
    this.failures.length = 0
  }

  private prune(now: number): void {
    const cutoff = now - this.options.windowMs
    while (this.failures.length > 0 && (this.failures[0] ?? now) <= cutoff) {
      this.failures.shift()
    }
  }
}

function laterAction(
  left: Exclude<RecoveryAction, 'open-circuit'>,
  right: Exclude<RecoveryAction, 'open-circuit'>
): Exclude<RecoveryAction, 'open-circuit'> {
  return ACTION_ORDER.indexOf(left) >= ACTION_ORDER.indexOf(right) ? left : right
}
