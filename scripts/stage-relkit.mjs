// @ts-check
// 取回并验签本平台的 relkit-updater，并守住协议副本不漂移：
//
//   updater → .relkit/stage/<target>/relkit-updater[.exe]
//             producer 经 electron-builder extraFiles 放到主程序旁边
//             （macOS: Contents/MacOS/relkit-updater；Windows: 安装目录根），
//             引擎跟版本走，每个版本的 payload 都带自己的那一份。
//
// relkit 不提供客户端库：宿主类型从仓内 proto/updater/v2/updater.proto 生成。
// 这里用刚验签的引擎执行 `relkit-updater proto`，与副本逐字节比对，不一致即失败。
//
// 引擎只从 relkit.project.json 声明的服务器 current/ 拿，用根公钥验签；
// 宿主仓不记录任何版本、摘要或二进制。
//
// 离线复用：AGENTIC_RELKIT_OFFLINE=1 且引擎已存在时跳过下载。
// 交叉构建（目标与本机平台不同、引擎无法在本机执行）时跳过比对，由同平台 CI 守住。

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
export const PROTO_COPY = join(root, 'proto', 'updater', 'v2', 'updater.proto')
export const RELKIT_TARGETS = /** @type {const} */ ([
  'windows-amd64',
  'darwin-arm64',
  'darwin-amd64'
])

/**
 * @param {string} target
 * @returns {string}
 */
export function stagedUpdaterPath(target) {
  if (!RELKIT_TARGETS.includes(/** @type {never} */ (target))) {
    throw new Error(
      `relkit 不支持目标 ${target}（可选：${RELKIT_TARGETS.join('、')}）`
    )
  }
  const name = target.startsWith('windows')
    ? 'relkit-updater.exe'
    : 'relkit-updater'
  return join(root, '.relkit', 'stage', target, name)
}

/**
 * @param {NodeJS.Platform} [platform]
 * @param {string} [arch]
 */
export function hostTarget(platform = process.platform, arch = process.arch) {
  const os = { darwin: 'darwin', win32: 'windows', linux: 'linux' }[
    /** @type {string} */ (platform)
  ]
  const cpu = { x64: 'amd64', arm64: 'arm64' }[arch]
  return os && cpu ? `${os}-${cpu}` : `${platform}-${arch}`
}

/**
 * @param {{ target: string }} options
 */
export function stageRelkit({ target }) {
  const updaterPath = stagedUpdaterPath(target)
  const directory = join(updaterPath, '..')
  const offline = process.env.AGENTIC_RELKIT_OFFLINE === '1'

  if (!(offline && existsSync(updaterPath))) {
    rmSync(directory, { recursive: true, force: true })
    mkdirSync(directory, { recursive: true })
    fetchTool([
      '--component',
      'updater',
      '--platform',
      target,
      '--out-dir',
      directory,
      '--out-name',
      updaterPath.slice(directory.length + 1)
    ])
    rmSync(join(directory, 'relkit_allowed_signers'), { force: true })
  }
  if (!target.startsWith('windows')) {
    chmodSync(updaterPath, 0o755)
  }
  console.log(`✓ relkit updater：${updaterPath}`)

  if (target === hostTarget()) {
    checkProtoDrift(updaterPath)
  } else {
    console.log(`… 交叉构建 ${target}，跳过 updater proto 比对`)
  }
  return updaterPath
}

/**
 * @param {string} updaterPath
 */
export function checkProtoDrift(updaterPath) {
  const result = spawnSync(updaterPath, ['proto'], {
    encoding: 'buffer',
    maxBuffer: 16 << 20
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(
      `relkit-updater proto 失败：${result.stderr.toString().trim()}`
    )
  }
  const copy = existsSync(PROTO_COPY)
    ? readFileSync(PROTO_COPY)
    : Buffer.alloc(0)
  if (!copy.equals(result.stdout)) {
    throw new Error(
      `updater proto drift：${PROTO_COPY} 与引擎导出不一致；` +
        "用 'relkit-updater proto > proto/updater/v2/updater.proto' 刷新副本，" +
        '再 npm run proto:gen 并适配 src/main/updater'
    )
  }
  console.log('✓ updater proto 副本与引擎一致')
}

/**
 * @param {string[]} args
 */
function fetchTool(args) {
  const python =
    process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  const result = spawnSync(
    python,
    [join(root, 'scripts', 'relkit_tool.py'), ...args],
    {
      cwd: root,
      stdio: ['ignore', 2, 2]
    }
  )
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`relkit 工具取回失败：relkit_tool.py ${args.join(' ')}`)
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const target = process.argv[2] ?? hostTarget()
    stageRelkit({ target })
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
