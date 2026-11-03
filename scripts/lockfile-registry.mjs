// @ts-check
// 保证 package-lock.json 里的下载地址都指向公网 npm 源。
//
// 本机若配置了内网镜像（如 mirrors.tencent.com），npm install 会把镜像地址
// 写进 lockfile 的 resolved 字段。Dependabot 和外部 CI 访问不到这些地址，
// 2026-10-20 起曾因此连续两周有十几个依赖拿不到升级 PR。
//
// 不在仓库里用 .npmrc 锁死公网源，是为了不干预本机装依赖时用哪个镜像；
// 镜像只影响下载来源，integrity 校验值与公网一致，改回地址即可。
//
// 用法：
//   node scripts/lockfile-registry.mjs check   发现非公网地址即失败
//   node scripts/lockfile-registry.mjs fix     把镜像地址改回公网 npm

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PUBLIC_REGISTRY = 'https://registry.npmjs.org/'

const root = import.meta.dirname
  ? join(import.meta.dirname, '..')
  : process.cwd()
const lockfilePath = join(root, 'package-lock.json')

/**
 * 从 lockfile 的包路径推出包名，例如
 * node_modules/a/node_modules/@scope/b → @scope/b。
 * @param {string} key
 */
function packageNameFromKey(key) {
  const marker = 'node_modules/'
  const index = key.lastIndexOf(marker)
  return index === -1 ? null : key.slice(index + marker.length)
}

/**
 * @param {string} key
 * @param {string} resolved
 * @returns {string | null} 对应的公网地址；无法推断时返回 null
 */
function toPublicUrl(key, resolved) {
  const name = packageNameFromKey(key)
  if (!name) {
    return null
  }
  const anchor = `/${name}/-/`
  const index = resolved.indexOf(anchor)
  if (index === -1) {
    return null
  }
  return `${PUBLIC_REGISTRY}${resolved.slice(index + 1)}`
}

const mode = process.argv[2]
if (mode !== 'check' && mode !== 'fix') {
  console.error('用法：node scripts/lockfile-registry.mjs <check|fix>')
  process.exit(2)
}

const raw = readFileSync(lockfilePath, 'utf8')
/** @type {{ packages?: Record<string, { resolved?: string }> }} */
const lockfile = JSON.parse(raw)

/** @type {{ key: string, from: string, to: string | null }[]} */
const offenders = []
for (const [key, entry] of Object.entries(lockfile.packages ?? {})) {
  const resolved = entry.resolved
  // 只管走 registry 下载的 tarball；git、file 等来源不在此列
  if (!resolved || !/^https?:\/\//.test(resolved)) {
    continue
  }
  if (resolved.startsWith(PUBLIC_REGISTRY)) {
    continue
  }
  offenders.push({ key, from: resolved, to: toPublicUrl(key, resolved) })
}

if (offenders.length === 0) {
  console.log('lockfile 下载地址均指向公网 npm 源')
  process.exit(0)
}

const unfixable = offenders.filter((item) => item.to === null)

if (mode === 'check') {
  const hosts = [...new Set(offenders.map((item) => new URL(item.from).host))]
  console.error(
    `package-lock.json 有 ${offenders.length} 条下载地址不是公网 npm 源（${hosts.join('、')}）。`
  )
  for (const item of offenders.slice(0, 5)) {
    console.error(`  ${item.key}: ${item.from}`)
  }
  if (offenders.length > 5) {
    console.error(`  ……另有 ${offenders.length - 5} 条`)
  }
  console.error('Dependabot 访问不到这些地址。执行 npm run lockfile:fix 改回。')
  process.exit(1)
}

if (unfixable.length > 0) {
  console.error('以下地址无法推断公网对应地址，需要手工处理：')
  for (const item of unfixable) {
    console.error(`  ${item.key}: ${item.from}`)
  }
  process.exit(1)
}

let next = raw
for (const item of offenders) {
  next = next.replace(`"resolved": "${item.from}"`, `"resolved": "${item.to}"`)
}
writeFileSync(lockfilePath, next)
console.log(`已把 ${offenders.length} 条下载地址改回公网 npm 源`)
