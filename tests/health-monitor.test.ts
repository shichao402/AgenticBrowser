import { describe, expect, it, vi } from 'vitest'

import { HealthMonitor } from '../src/main/health-monitor'

describe('HealthMonitor', () => {
  it('marks degradation, notifies once at the threshold, and recovers', async () => {
    const responses = [false, false, false, true]
    const onChange = vi.fn()
    const onUnhealthy = vi.fn()
    const monitor = new HealthMonitor(
      async () => responses.shift() ?? true,
      onChange,
      onUnhealthy,
      {
        intervalMs: 1_000,
        timeoutMs: 100,
        failureThreshold: 2
      }
    )

    await monitor.checkNow()
    expect(monitor.getSnapshot()).toMatchObject({
      status: 'degraded',
      consecutiveFailures: 1
    })

    await monitor.checkNow()
    expect(monitor.getSnapshot()).toMatchObject({
      status: 'unresponsive',
      consecutiveFailures: 2
    })
    expect(onUnhealthy).toHaveBeenCalledTimes(1)

    await monitor.checkNow()
    expect(onUnhealthy).toHaveBeenCalledTimes(1)

    await monitor.checkNow()
    expect(monitor.getSnapshot()).toMatchObject({
      status: 'healthy',
      consecutiveFailures: 0
    })
    expect(onChange).toHaveBeenCalled()
  })

  it('treats a probe timeout as a failed heartbeat', async () => {
    const monitor = new HealthMonitor(
      () => new Promise<boolean>(() => undefined),
      () => undefined,
      () => undefined,
      {
        intervalMs: 1_000,
        timeoutMs: 5,
        failureThreshold: 1
      }
    )

    await monitor.checkNow()
    expect(monitor.getSnapshot().status).toBe('unresponsive')
  })
})
