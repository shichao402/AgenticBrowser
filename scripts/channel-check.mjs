// @ts-check
// 校验 VERSION.json 里两档清单的完整性与关系约束。
//
// 单独成脚本的原因：这些约束必须在 CI 里跑，而不是等到打包那天
// 才发现开发档目录名带了空格。

import { join } from 'node:path'

import { loadChannels } from './channel-identity.mjs'

const root = import.meta.dirname
  ? join(import.meta.dirname, '..')
  : process.cwd()

try {
  const { version, profiles } = loadChannels(root)
  console.log(`档位清单有效，版本 ${version}`)
  console.log(
    `  正式档：${profiles.release.displayName} → ${profiles.release.installDirectoryName}`
  )
  console.log(
    `  开发档：${profiles.dev.displayName} → ${profiles.dev.installDirectoryName}`
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
