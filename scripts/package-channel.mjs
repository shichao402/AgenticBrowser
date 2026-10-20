// @ts-check
// 按档位构建并打包。
//
// 正式档使用仓库里的 package.json 构建配置；开发档用一次性 CLI 覆盖
// 注入显示名、标识与产物前缀，绝不写回 package.json。构建结束无论
// 成功还是失败，都把 out/ 恢复成正式档身份，避免工作区停在开发档上。

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { selectChannel } from './channel-identity.mjs'

const root = import.meta.dirname
  ? join(import.meta.dirname, '..')
  : process.cwd()

/**
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [extraEnv]
 */
function run(command, args, extraEnv) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, ...extraEnv }
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} 失败，退出码 ${result.status}`
    )
  }
}

/**
 * 只做构建，不打包。用于把 out/ 刷成指定档位。
 * @param {'release' | 'dev'} channel
 */
export function buildChannel(channel) {
  run(
    process.execPath,
    [
      join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'),
      'build'
    ],
    {
      AGENTIC_CHANNEL: channel
    }
  )
}

/**
 * 开发档的打包覆盖。字段与 package.json 里的正式档一一对应，
 * 只是取值为开发档。不写回文件。
 * @param {import('./channel-identity.mjs').ChannelProfile} profile
 * @returns {string[]}
 */
function devOverrides(profile) {
  return [
    `-c.appId=${profile.appId}`,
    `-c.productName=${profile.displayName}`,
    `-c.directories.output=release/${profile.installDirectoryName}`,
    `-c.nsis.shortcutName=${profile.displayName}`,
    `-c.nsis.artifactName=${profile.artifactPrefix}-\${version}-win-\${arch}.\${ext}`,
    `-c.win.artifactName=${profile.artifactPrefix}-\${version}-win-\${arch}.\${ext}`,
    `-c.mac.artifactName=${profile.artifactPrefix}-\${version}-mac-\${arch}.\${ext}`
  ]
}

/**
 * 打真正的安装包。正式档不传覆盖，直接使用仓库里的规范配置。
 * @param {'release' | 'dev'} channel
 * @param {import('./channel-identity.mjs').ChannelProfile} profile
 * @param {string[]} extraArgs
 */
export function packageChannel(channel, profile, extraArgs = []) {
  const args = [
    join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'),
    '--publish',
    'never',
    ...(channel === 'dev' ? devOverrides(profile) : []),
    ...extraArgs
  ]
  run(process.execPath, args)
}

/**
 * @param {string | undefined} raw
 */
export function runPipeline(raw) {
  const { channel, profile } = selectChannel(root, raw)
  let failure = null
  try {
    buildChannel(channel)
    packageChannel(channel, profile)
    console.log(
      `已生成 ${channel} 档安装包：release/${profile.installDirectoryName}`
    )
  } catch (error) {
    failure = error
  } finally {
    if (channel === 'dev') {
      // 无论成功失败都恢复正式档身份。失败也要恢复，否则下一次
      // 直接跑 electron . 会拿到开发档的数据目录和标题。
      try {
        buildChannel('release')
        console.log('已把 out/ 恢复为正式档身份')
      } catch (restoreError) {
        console.error(
          `恢复正式档失败：${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
        )
        if (!failure) {
          failure = restoreError
        }
      }
    }
  }
  if (failure) {
    throw failure
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    runPipeline(process.argv[2])
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
