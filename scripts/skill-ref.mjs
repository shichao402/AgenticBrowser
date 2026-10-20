// 手动维护：Skill 发布版本派生
//
// Dec registry 的 tag 是 registry/<project>/<ref>。同一 ref 下内容不同会被
// 拒绝发布，因此每次会影响发布产物的变更都必须换 ref。手工维护版本号容易
// 忘记，这里改为从 Git 历史派生。
//
// ref = <BASE_VERSION>+<影响发布产物的提交数>
//
// 这正是 Dec 自己的约定：注册表发版用 v0.1.0+4 这种形式，同一 semver 上
// +N 递增（见 internal/registry 的 compareVersion 注释）。
//
// 三个性质正好是发布需要的：
// - 内容没变，提交数不变，ref 不变，publish 走幂等分支，不产生空提交。
// - 内容一变，就必然产生一次新提交，提交数 +1，ref 单调递增且唯一。
// - 提交数与 App 的 VERSION.json 无关，应用发版不会带出内容重复的 skill 版本。
//
// 计数口径包含 skill 目录与 Dec 配置：改 visibility、plane 之类同样会改变
// 发布产物，也必须换 ref，否则会撞上「tag 已存在且内容不同」的拒绝。
//
// 不用 npm version 的原因是它会剥掉 +build 元数据，导致 ref 退化成固定值。

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SKILL_RELATIVE_PATH } from './api-docs/lib/type-source.mjs'

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)

// 需要手动提升时改这里：破坏性重写 skill 结构就抬到 v0.2.0，让 +N 重新计数。
const BASE_VERSION = 'v0.1.0'

// 影响发布产物的路径。任何一个有提交，ref 就要变。
const PUBLISHED_PATHS = [SKILL_RELATIVE_PATH, '.dec/config.yaml']

function git(args) {
  const result = spawnSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    shell: false
  })
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} 失败：${result.stderr?.trim() || '未知错误'}`
    )
  }
  return result.stdout.trim()
}

function commitCount() {
  const raw = git(['rev-list', '--count', 'HEAD', '--', ...PUBLISHED_PATHS])
  const count = Number.parseInt(raw, 10)
  if (!Number.isInteger(count)) {
    throw new Error(`无法统计发布内容的提交数，得到 ${JSON.stringify(raw)}`)
  }
  if (count < 1) {
    throw new Error(
      `发布内容还没有任何提交历史（${PUBLISHED_PATHS.join('、')}）；` +
        '先提交 skill，再发布'
    )
  }
  return count
}

function ref() {
  return `${BASE_VERSION}+${commitCount()}`
}

function main() {
  const command = process.argv[2]
  if (command === 'print') {
    process.stdout.write(`${ref()}\n`)
    return
  }
  if (command === 'check') {
    console.log(`skill ref ${ref()}`)
    console.log(`  基准版本：${BASE_VERSION}`)
    console.log(`  计数口径：${PUBLISHED_PATHS.join('、')}`)
    return
  }
  throw new Error('用法: node scripts/skill-ref.mjs <print|check>')
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
