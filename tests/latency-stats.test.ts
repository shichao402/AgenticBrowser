import { describe, expect, it } from 'vitest'

import { summarizeLatencies } from '../src/main/latency-stats'

describe('summarizeLatencies', () => {
  it('returns zeroed stats for no samples', () => {
    expect(summarizeLatencies([])).toEqual({
      sampleCount: 0,
      averageMs: 0,
      p95Ms: 0,
      maximumMs: 0
    })
  })

  it('handles a single sample', () => {
    // 单样本时 p95 必须落在唯一的元素上，不能越界成 0。
    expect(summarizeLatencies([7])).toEqual({
      sampleCount: 1,
      averageMs: 7,
      p95Ms: 7,
      maximumMs: 7
    })
  })

  it('averages and reports the maximum', () => {
    const stats = summarizeLatencies([10, 20, 30])
    expect(stats.averageMs).toBeCloseTo(20, 10)
    expect(stats.maximumMs).toBe(30)
  })

  it('does not reorder the caller array', () => {
    // 采样期间调用方持有同一个数组继续追加，排序入参会污染它。
    const samples = [30, 10, 20]
    summarizeLatencies(samples)
    expect(samples).toEqual([30, 10, 20])
  })

  it('picks the ceiling index for p95', () => {
    // 20 个样本时 ceil(20 * 0.95) = 19，0-based 下标 18，
    // 即第二大的值，而不是最大值。
    const samples = Array.from({ length: 20 }, (_, index) => index + 1)
    const stats = summarizeLatencies(samples)
    expect(stats.p95Ms).toBe(19)
    expect(stats.maximumMs).toBe(20)
  })

  it('never indexes past the end for large samples', () => {
    // ceil(n * 0.95) 在 n = 100 时等于 95，下标 94，
    // 若实现漏掉 -1 就会取到第 95 个之后的元素。
    const samples = Array.from({ length: 100 }, (_, index) => index + 1)
    const stats = summarizeLatencies(samples)
    expect(stats.p95Ms).toBe(95)
  })

  it('clamps p95 to the maximum for very small samples', () => {
    // 2 个样本时 ceil(2 * 0.95) - 1 = 1，取最大值。
    expect(summarizeLatencies([5, 9]).p95Ms).toBe(9)
  })

  it('keeps p95 at or below the maximum for every size up to 200', () => {
    // 穷举小规模样本数，覆盖 p95 下标随 n 变化的每一段。
    for (let size = 1; size <= 200; size += 1) {
      const samples = Array.from({ length: size }, (_, index) => index + 1)
      const stats = summarizeLatencies(samples)
      expect(stats.p95Ms).toBeLessThanOrEqual(stats.maximumMs)
      expect(stats.p95Ms).toBeGreaterThanOrEqual(1)
      expect(stats.sampleCount).toBe(size)
    }
  })

  it('handles identical samples', () => {
    const stats = summarizeLatencies([4, 4, 4, 4])
    expect(stats.p95Ms).toBe(4)
    expect(stats.maximumMs).toBe(4)
    expect(stats.averageMs).toBe(4)
  })

  it('preserves fractional durations', () => {
    const stats = summarizeLatencies([1.5, 2.5])
    expect(stats.averageMs).toBeCloseTo(2, 10)
    expect(stats.maximumMs).toBe(2.5)
  })
})
