// @ts-check
// 构建期档位选择。被 electron.vite.config.ts、打包脚本和本地部署脚本
// 共同引用，保证"选哪一档"只有一处判断。
//
// 缺省正式档；非法值直接失败而不是静默回落，因为拼错的档位名会让
// 开发者以为在打开发包却拿到正式包。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** @typedef {'release' | 'dev'} ChannelName */

/**
 * @typedef {object} ChannelProfile
 * @property {string} displayName
 * @property {string} installDirectoryName
 * @property {string} appId
 * @property {string} iconSet
 * @property {string} userDataDirectoryName
 * @property {string} artifactPrefix
 */

const CHANNEL_NAMES = ['release', 'dev']
const DEFAULT_CHANNEL = 'release'

const PROFILE_FIELDS = [
  'displayName',
  'installDirectoryName',
  'appId',
  'iconSet',
  'userDataDirectoryName',
  'artifactPrefix'
]

/**
 * @param {string} root
 * @returns {Record<string, unknown>}
 */
export function readVersionManifest(root) {
  const raw = readFileSync(join(root, 'VERSION.json'), 'utf8')
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `VERSION.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} field
 * @param {string} channel
 * @returns {string}
 */
function requireString(record, field, channel) {
  const value = record[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`channels.${channel}.${field} 必须是非空字符串`)
  }
  return value
}

/**
 * @param {Record<string, unknown>} channels
 * @param {string} channel
 * @returns {ChannelProfile}
 */
function parseProfile(channels, channel) {
  const record = channels[channel]
  if (typeof record !== 'object' || record === null) {
    throw new Error(`VERSION.json 缺少 channels.${channel}`)
  }
  const source = /** @type {Record<string, unknown>} */ (record)
  /** @type {Record<string, string>} */
  const profile = {}
  for (const field of PROFILE_FIELDS) {
    profile[field] = requireString(source, field, channel)
  }
  return /** @type {ChannelProfile} */ (profile)
}

/**
 * @param {{ release: ChannelProfile, dev: ChannelProfile }} profiles
 * @returns {string[]}
 */
export function validatePair(profiles) {
  /** @type {string[]} */
  const problems = []
  const { release, dev } = profiles

  if (dev.installDirectoryName !== `${release.installDirectoryName}Dev`) {
    problems.push(
      `开发档安装目录名应为 ${release.installDirectoryName}Dev，当前是 ${dev.installDirectoryName}`
    )
  }
  if (/\s/.test(dev.installDirectoryName)) {
    problems.push('开发档安装目录名不能包含空白字符')
  }
  /** @type {Array<[keyof ChannelProfile, string]>} */
  const distinctFields = [
    ['displayName', '显示名'],
    ['appId', '应用标识'],
    ['userDataDirectoryName', '数据目录名'],
    ['iconSet', '图标集'],
    ['artifactPrefix', '安装包前缀']
  ]
  for (const [key, label] of distinctFields) {
    if (dev[key] === release[key]) {
      problems.push(`两档${label}必须不同，否则无法并排共存`)
    }
  }
  return problems
}

/**
 * @param {string} root
 * @returns {{ version: string, profiles: { release: ChannelProfile, dev: ChannelProfile } }}
 */
export function loadChannels(root) {
  const manifest = readVersionManifest(root)
  const channels = manifest.channels
  if (typeof channels !== 'object' || channels === null) {
    throw new Error('VERSION.json 缺少 channels 字段')
  }
  const source = /** @type {Record<string, unknown>} */ (channels)
  const profiles = {
    release: parseProfile(source, 'release'),
    dev: parseProfile(source, 'dev')
  }
  const problems = validatePair(profiles)
  if (problems.length > 0) {
    throw new Error(problems.join('\n'))
  }
  return { version: String(manifest.version ?? ''), profiles }
}

/**
 * @param {unknown} raw
 * @returns {ChannelName}
 */
export function resolveChannel(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return /** @type {ChannelName} */ (DEFAULT_CHANNEL)
  }
  if (typeof raw !== 'string' || !CHANNEL_NAMES.includes(raw)) {
    throw new Error(
      `未知档位 ${String(raw)}，可选值：${CHANNEL_NAMES.join(', ')}`
    )
  }
  return /** @type {ChannelName} */ (raw)
}

/**
 * @param {string} root
 * @param {unknown} raw
 * @returns {{ channel: ChannelName, version: string, profile: ChannelProfile, profiles: { release: ChannelProfile, dev: ChannelProfile } }}
 */
export function selectChannel(root, raw) {
  const channel = resolveChannel(raw)
  const { version, profiles } = loadChannels(root)
  return { channel, version, profile: profiles[channel], profiles }
}
