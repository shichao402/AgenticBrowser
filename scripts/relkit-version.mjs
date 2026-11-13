// @ts-check
// Relkit 发布身份：version / channel / releaseCode / 档位的唯一计算处。
//
//   x.y.z ：只取自 VERSION.json
//   code  ：由 relkit 服务器分配，CI 在 plan job 用 `relkit release-code claim`
//           领一次，再经 --code 传进来；一次发布只领一个号，矩阵各平台共用
//   stable：由 tag v<x.y.z> 触发，tag 必须等于 VERSION.json；version = <x.y.z>+<code>
//   dev   ：手动触发，version = <x.y.z>-dev.<code>+<code>
//
// relkit 渠道与本项目档位一一对应：stable → release 档，dev → dev 档。
// electron-builder 与 package.json 仍只用纯 x.y.z；code 经构建期 define 注入主进程。

import { appendFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** @typedef {'stable' | 'dev'} RelkitChannel */

export const RELKIT_CHANNELS = /** @type {const} */ (['stable', 'dev'])

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')

/** @returns {string} */
export function readBaseVersion() {
  const manifest = JSON.parse(readFileSync(join(root, 'VERSION.json'), 'utf8'))
  return String(manifest.version ?? '')
}

/**
 * @param {string | undefined} tag
 * @param {string} baseVersion
 */
export function assertTagMatches(tag, baseVersion) {
  if (tag !== `v${baseVersion}`) {
    throw new Error(
      `stable 发布的 tag 必须是 v${baseVersion}（VERSION.json），当前是 ${tag || '<空>'}`
    )
  }
}

/**
 * @param {unknown} channel
 * @returns {RelkitChannel}
 */
function requireChannel(channel) {
  if (channel !== 'stable' && channel !== 'dev') {
    throw new Error(
      `渠道只能是 stable 或 dev，当前是 ${String(channel ?? '<空>')}`
    )
  }
  return channel
}

/**
 * @param {{ channel: unknown, tag?: string | undefined, baseVersion: string, code: unknown }} input
 */
export function computeRelease({
  channel: rawChannel,
  tag,
  baseVersion,
  code: rawCode
}) {
  const channel = requireChannel(rawChannel)
  const code = Number(String(rawCode ?? '').trim())
  if (!Number.isSafeInteger(code) || code <= 0) {
    throw new Error(
      `releaseCode 必须是服务器分配的正整数，当前是 ${String(rawCode ?? '<空>')}`
    )
  }
  if (!/^\d+\.\d+\.\d+$/.test(baseVersion)) {
    throw new Error(`VERSION.json 版本不是 x.y.z：${baseVersion}`)
  }
  if (channel === 'stable') {
    assertTagMatches(tag, baseVersion)
    return {
      channel,
      code,
      semver: baseVersion,
      version: `${baseVersion}+${code}`,
      profile: /** @type {const} */ ('release')
    }
  }
  return {
    channel,
    code,
    semver: baseVersion,
    version: `${baseVersion}-dev.${code}+${code}`,
    profile: /** @type {const} */ ('dev')
  }
}

/**
 * producer 侧：从 relkit 传入的 version 取回 releaseCode（`+N`）。
 * @param {unknown} version
 */
export function releaseCodeFromVersion(version) {
  const match = /\+(\d+)$/.exec(String(version ?? ''))
  if (!match) {
    throw new Error(`relkit 版本必须以 +<releaseCode> 结尾：${String(version)}`)
  }
  const code = Number(match[1])
  if (!Number.isSafeInteger(code) || code <= 0) {
    throw new Error(`releaseCode 非法：${String(version)}`)
  }
  return code
}

/**
 * producer 侧：从 relkit 传入的 version 取回 x.y.z。
 * @param {unknown} version
 */
export function semverFromVersion(version) {
  const match = /^(\d+\.\d+\.\d+)(?:-dev\.\d+)?\+\d+$/.exec(
    String(version ?? '')
  )
  if (!match?.[1]) {
    throw new Error(
      `relkit 版本应为 <x.y.z>+<code> 或 <x.y.z>-dev.<code>+<code>：${String(version)}`
    )
  }
  return match[1]
}

/**
 * relkit 渠道对应的构建档位。
 * @param {unknown} channel
 * @returns {'release' | 'dev'}
 */
export function profileForChannel(channel) {
  return requireChannel(channel) === 'dev' ? 'dev' : 'release'
}

/**
 * @param {string[]} args
 * @param {string} name
 */
function flag(args, name) {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2)
    const channel = flag(args, '--channel')
    const code = flag(args, '--code')
    if (channel === undefined || code === undefined) {
      throw new Error(
        '用法：node scripts/relkit-version.mjs --channel <stable|dev> --code "$(relkit release-code claim)"'
      )
    }
    const release = computeRelease({
      channel,
      tag: process.env.AGENTIC_RELEASE_TAG ?? process.env.GITHUB_REF_NAME,
      baseVersion: readBaseVersion(),
      code
    })
    for (const [key, value] of Object.entries(release)) {
      const line = `${key}=${value}\n`
      if (process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT, line)
      }
      process.stdout.write(line)
    }
  } catch (error) {
    console.error(
      `relkit 版本计算失败：${error instanceof Error ? error.message : String(error)}`
    )
    process.exitCode = 1
  }
}
