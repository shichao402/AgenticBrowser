import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 冒烟结果落盘。
 *
 * 入口原先为每种冒烟各写一个 `write*SmokeResult`，逻辑逐字重复八次，
 * 只差「开关 + 文件名」。这里收敛成一张表加一个函数：新增场景只需加一行，
 * 也不会出现某个场景漏写结果文件、CI 上拿不到分析依据的情况。
 */

export interface SmokeResultTarget {
  /** 该场景是否由本次启动触发。 */
  enabled: boolean
  /** 结果文件名，落在工作目录下。 */
  fileName: string
}

export function writeSmokeResultFile(
  target: SmokeResultTarget,
  result: unknown,
  workingDirectory: string = process.cwd()
): void {
  if (!target.enabled) {
    return
  }
  writeFileSync(
    join(workingDirectory, target.fileName),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8'
  )
}
