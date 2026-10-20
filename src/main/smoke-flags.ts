/**
 * 冒烟测试入口标志。
 *
 * 每个标志对应 package.json 中一个 smoke 脚本传入的命令行参数。集中在此
 * 模块后，主进程入口与冒烟实现可以共享同一份判定，而不必互相 import。
 */

const argv = process.argv

export const smokeTest = argv.includes('--smoke-test')
export const recoverySmokeTest = argv.includes('--recovery-smoke-test')
export const strategyFaultSmokeTest = argv.includes(
  '--strategy-fault-smoke-test'
)
export const strategyWorkspaceSmokeTest = argv.includes(
  '--strategy-workspace-smoke-test'
)
export const projectDownloadSmokeTest = argv.includes(
  '--project-download-smoke-test'
)
export const projectConcurrencySmokeTest = argv.includes(
  '--project-concurrency-smoke-test'
)
export const projectTakeoverSmokeTest = argv.includes(
  '--project-takeover-smoke-test'
)
export const automationPlaygroundSmokeTest = argv.includes(
  '--automation-playground-smoke-test'
)
export const watchdogSmokeChild = argv.includes('--watchdog-smoke-child')
export const projectDownloadRecoverySmokeChild = argv.includes(
  '--project-download-recovery-smoke-child'
)
export const projectDownloadFaultSmokeChild = argv.includes(
  '--project-download-fault-smoke-child'
)
export const projectDownloadRendererRecoverySmokeChild = argv.includes(
  '--project-download-renderer-recovery-smoke-child'
)

/**
 * 是否为任一冒烟入口（含子进程模式）。
 */
export const automatedTestRun =
  smokeTest ||
  recoverySmokeTest ||
  strategyFaultSmokeTest ||
  strategyWorkspaceSmokeTest ||
  projectDownloadSmokeTest ||
  projectConcurrencySmokeTest ||
  projectTakeoverSmokeTest ||
  automationPlaygroundSmokeTest ||
  watchdogSmokeChild ||
  projectDownloadRecoverySmokeChild ||
  projectDownloadFaultSmokeChild ||
  projectDownloadRendererRecoverySmokeChild

/**
 * 会启动 Phase 0 探测服务器的主场景。
 *
 * 子进程模式（watchdog / 下载恢复）复用外部已启动的探测服务，因此不在此列。
 */
export const usesPhaseZeroProbe =
  smokeTest ||
  recoverySmokeTest ||
  strategyFaultSmokeTest ||
  strategyWorkspaceSmokeTest ||
  projectDownloadSmokeTest ||
  projectConcurrencySmokeTest ||
  projectTakeoverSmokeTest

/**
 * 需要临时下载目录与内存态存储的主场景。
 */
export const usesAutomatedDownloadDirectory =
  smokeTest ||
  recoverySmokeTest ||
  strategyFaultSmokeTest ||
  strategyWorkspaceSmokeTest ||
  projectDownloadSmokeTest ||
  projectConcurrencySmokeTest ||
  projectTakeoverSmokeTest ||
  automationPlaygroundSmokeTest
