export interface LatencyStats {
  sampleCount: number
  averageMs: number
  p95Ms: number
  maximumMs: number
}

// 延迟统计。此前是 browser-supervisor 的私有函数，只能通过真实渲染
// 进程采样触发。p95 的下标计算最容易在样本数变化时出错，这里单独
// 实现并测试边界。

export function summarizeLatencies(durations: number[]): LatencyStats {
  if (durations.length === 0) {
    return {
      sampleCount: 0,
      averageMs: 0,
      p95Ms: 0,
      maximumMs: 0
    }
  }

  // 不排序入参：调用方传入的是采样期间的实时数组，排序会打乱它。
  const sorted = [...durations].sort((left, right) => left - right)
  const p95Index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * 0.95) - 1
  )

  return {
    sampleCount: durations.length,
    averageMs:
      durations.reduce((total, duration) => total + duration, 0) /
      durations.length,
    p95Ms: sorted[p95Index] ?? 0,
    maximumMs: sorted.at(-1) ?? 0
  }
}
