import { describe, expect, it } from 'vitest'

import { RecoveryPolicy } from '../src/main/recovery-policy'

const options = {
  maxAttempts: 4,
  windowMs: 10_000,
  baseDelayMs: 100,
  maximumDelayMs: 500
}

describe('RecoveryPolicy', () => {
  it('escalates reload, cache bypass, cache clear, view recreation, then opens the circuit', () => {
    const policy = new RecoveryPolicy(options)

    expect(policy.next('load-failed', 1_000)).toMatchObject({
      action: 'reload',
      attempt: 1,
      delayMs: 100
    })
    expect(policy.next('load-failed', 2_000)).toMatchObject({
      action: 'reload-ignore-cache',
      attempt: 2,
      delayMs: 200
    })
    expect(policy.next('load-failed', 3_000)).toMatchObject({
      action: 'clear-cache-and-reload',
      attempt: 3,
      delayMs: 400
    })
    expect(policy.next('load-failed', 4_000)).toMatchObject({
      action: 'recreate-view',
      attempt: 4,
      delayMs: 500
    })
    expect(policy.next('load-failed', 5_000)).toMatchObject({
      action: 'open-circuit',
      attempt: 5,
      delayMs: 0
    })
  })

  it('never chooses an action weaker than the failure requires', () => {
    const policy = new RecoveryPolicy(options)

    expect(policy.next('renderer-gone', 1_000, 'recreate-view').action).toBe(
      'recreate-view'
    )
    expect(policy.next('renderer-gone', 2_000, 'recreate-view').action).toBe(
      'recreate-view'
    )
  })

  it('expires old attempts and supports an explicit operator reset', () => {
    const policy = new RecoveryPolicy(options)
    policy.next('load-failed', 1_000)
    policy.next('load-failed', 2_000)

    expect(policy.getAttempts(12_001)).toBe(0)
    expect(policy.next('load-failed', 12_001).attempt).toBe(1)
    policy.reset()
    expect(policy.getAttempts(12_002)).toBe(0)
  })

  it('caps exponential backoff', () => {
    const policy = new RecoveryPolicy({
      ...options,
      maximumDelayMs: 250
    })

    expect(policy.next('failure', 1_000).delayMs).toBe(100)
    expect(policy.next('failure', 2_000).delayMs).toBe(200)
    expect(policy.next('failure', 3_000).delayMs).toBe(250)
    expect(policy.next('failure', 4_000).delayMs).toBe(250)
  })
})
