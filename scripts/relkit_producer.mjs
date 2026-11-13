// @ts-check
// relkit artifact-producer（relkit.project.json → artifactProducer）。
//
// stdin ：relkit.artifact-producer-input/2（product / version / channel / target / outputDirectory）
// stdout：relkit.artifact-set/1，且只能输出这一份 JSON；所有构建日志走 stderr。
//
// 每个 target 产出一对制品：
//   installer：Windows NSIS setup.exe / macOS dmg（首次安装与手动兜底）
//   payload  ：安装后目录树的 relkit payload（IN_PLACE 自动更新用，payloadOf → installer）
//     Windows：electron-builder 的 win-unpacked 目录树。它与 NSIS 装出来的文件
//              一致，只少 NSIS 自己的卸载器；引擎只删除 baseline 登记过的文件，
//              所以卸载器会被保留，不必像 Tauri 那样静默安装一次。
//     macOS  ：整个 .app 作 BUNDLE 单元（relkit payload build --bundle），打包前
//              先过 codesign --verify --deep --strict。
//   两种 payload 都必须带本版本的 relkit-updater（引擎跟版本走）。
//
// 渠道决定档位：stable → release 档，dev → dev 档（不同 appId / 显示名 / 数据目录）。
// releaseCode 取 version 末尾的 +N，与 bootstrap 一起经构建期 define 编进主进程。

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { selectChannel } from './channel-identity.mjs'
import { devConfigOverrides } from './package-channel.mjs'
import {
  profileForChannel,
  releaseCodeFromVersion,
  semverFromVersion
} from './relkit-version.mjs'
import { stagedUpdaterPath } from './stage-relkit.mjs'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
export const PRODUCT = 'AgenticBrowser'
const INPUT_SCHEMA = 'relkit.artifact-producer-input/2'
const OUTPUT_SCHEMA = 'relkit.artifact-set/1'

/**
 * @typedef {object} TargetSpec
 * @property {NodeJS.Platform} platform
 * @property {'x64' | 'arm64'} arch
 */

/** @type {Record<string, TargetSpec>} */
export const TARGETS = {
  'windows-amd64': { platform: 'win32', arch: 'x64' },
  'darwin-arm64': { platform: 'darwin', arch: 'arm64' },
  'darwin-amd64': { platform: 'darwin', arch: 'x64' }
}

/**
 * @param {any} input
 */
export function validateInput(input) {
  if (input?.schema !== INPUT_SCHEMA) {
    throw new Error(`输入 schema 应为 ${INPUT_SCHEMA}，实际 ${input?.schema}`)
  }
  if (input.product !== PRODUCT) {
    throw new Error(`product 应为 ${PRODUCT}，实际 ${input.product}`)
  }
  const target = TARGETS[input.target]
  if (!target) {
    throw new Error(
      `不支持的 target ${input.target}（可选：${Object.keys(TARGETS).join('、')}）`
    )
  }
  if (!input.outputDirectory) {
    throw new Error('缺少 outputDirectory')
  }
  return {
    ...target,
    target: /** @type {string} */ (input.target),
    version: /** @type {string} */ (input.version),
    channel: /** @type {string} */ (input.channel),
    profile: profileForChannel(input.channel),
    code: releaseCodeFromVersion(input.version),
    semver: semverFromVersion(input.version),
    outputDirectory: /** @type {string} */ (input.outputDirectory)
  }
}

/**
 * 制品文件名不带空格和 `+`，并带上 target，merge 后全局唯一。
 * @param {{ artifactPrefix: string, semver: string, code: number, target: string }} options
 */
export function artifactNames({ artifactPrefix, semver, code, target }) {
  const stem = `${artifactPrefix}-${semver}-${code}-${target}`
  return {
    installer: target.startsWith('windows')
      ? `${stem}-setup.exe`
      : `${stem}.dmg`,
    payload: `${stem}.payload.zip`
  }
}

/**
 * 在配置对象上按点号路径写值（与 electron-builder 的 -c.a.b=v 同义）。
 * @param {Record<string, any>} config
 * @param {Record<string, unknown>} overrides
 */
export function applyOverrides(config, overrides) {
  for (const [path, value] of Object.entries(overrides)) {
    const keys = path.split('.')
    const last = /** @type {string} */ (keys.pop())
    let cursor = config
    for (const key of keys) {
      if (typeof cursor[key] !== 'object' || cursor[key] === null) {
        cursor[key] = {}
      }
      cursor = cursor[key]
    }
    cursor[last] = value
  }
  return config
}

/**
 * relkit 构建专用的 electron-builder 配置：仓库规范配置 + 档位覆盖 +
 * 引擎随包 + 独立输出目录。macOS 用 ad-hoc 签名，让 .app 能通过
 * codesign --verify --deep --strict（ad-hoc 不支持 hardened runtime）。
 * @param {{ baseConfig: Record<string, any>, profile: 'release' | 'dev', channelProfile: import('./channel-identity.mjs').ChannelProfile, target: string, updaterPath: string, outputDirectory: string }} options
 */
export function builderConfig({
  baseConfig,
  profile,
  channelProfile,
  target,
  updaterPath,
  outputDirectory
}) {
  const config = structuredClone(baseConfig)
  if (profile === 'dev') {
    applyOverrides(config, devConfigOverrides(channelProfile))
  }
  const windows = target.startsWith('windows')
  applyOverrides(config, {
    'directories.output': outputDirectory,
    extraFiles: [
      {
        from: updaterPath,
        to: windows ? 'relkit-updater.exe' : 'MacOS/relkit-updater'
      }
    ]
  })
  if (!windows) {
    applyOverrides(config, {
      'mac.identity': '-',
      'mac.hardenedRuntime': false
    })
  }
  return config
}

/** @param {string} message */
function log(message) {
  process.stderr.write(`[relkit-producer] ${message}\n`)
}

/**
 * @param {string} file
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 */
function run(file, args, env = process.env) {
  log(`$ ${[file, ...args].join(' ')}`)
  const result = spawnSync(file, args, {
    cwd: root,
    env,
    stdio: ['ignore', 2, 2]
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(
      `命令失败（退出码 ${result.status}）：${file} ${args.join(' ')}`
    )
  }
}

/**
 * @param {string} file
 * @param {string[]} args
 */
function capture(file, args) {
  const result = spawnSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 2]
  })
  return result.status === 0 ? result.stdout.trim() : ''
}

/**
 * @param {string} dir
 * @param {(name: string) => boolean} predicate
 * @param {string} label
 */
function single(dir, predicate, label) {
  const hits = existsSync(dir) ? readdirSync(dir).filter(predicate) : []
  if (hits.length !== 1) {
    throw new Error(
      `${dir} 下应恰有一个${label}，实际：${hits.join('、') || '无'}`
    )
  }
  return join(dir, /** @type {string} */ (hits[0]))
}

/** @param {string} path */
async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }
  return `sha256:${hash.digest('hex')}`
}

/**
 * @param {string} outputDirectory
 * @param {string} name
 * @param {Record<string, unknown>} fields
 */
async function describe(outputDirectory, name, fields) {
  const path = join(outputDirectory, name)
  return {
    ...fields,
    path: name,
    sha256: await sha256(path),
    size: statSync(path).size
  }
}

/**
 * @param {string} channel
 * @param {string} version
 */
function changelog(channel, version) {
  let range = ['-20']
  if (channel === 'stable') {
    const previous = capture('git', [
      'describe',
      '--tags',
      '--abbrev=0',
      '--match',
      'v*',
      'HEAD^'
    ])
    if (previous) {
      range = [`${previous}..HEAD`]
    }
  }
  const lines = capture('git', [
    'log',
    '--no-merges',
    '--format=- %s',
    ...range
  ])
  return lines || `- ${version}`
}

function relkitCli() {
  const cli =
    process.env.RELKIT_CLI ||
    join(
      root,
      '.relkit',
      'tools',
      process.platform === 'win32' ? 'relkit.exe' : 'relkit'
    )
  if (!existsSync(cli)) {
    throw new Error(
      `缺少 relkit CLI：${cli}（先用 scripts/relkit_tool.py 取回）`
    )
  }
  return cli
}

/**
 * 引擎跟版本走：payload 里必须带本版本的 relkit-updater。
 * @param {string} tree
 * @param {string} relpath
 */
export function assertEngineInTree(tree, relpath) {
  if (!existsSync(join(tree, relpath))) {
    throw new Error(
      `payload 缺少本版本引擎 ${relpath}（检查 extraFiles 与 stage-relkit）`
    )
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 */
function buildRenderer(env) {
  run(
    process.execPath,
    [
      join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'),
      'build'
    ],
    env
  )
}

/**
 * electron-builder 的日志写 stdout，而 producer 的 stdout 只能有 ArtifactSet；
 * 所以在子进程里跑 CLI（stdout 转到 stderr），配置走一次性的 JSON 文件。
 * @param {Record<string, any>} config
 * @param {TargetSpec} spec
 * @param {string} configPath
 */
function runElectronBuilder(config, spec, configPath) {
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
  run(process.execPath, [
    join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'),
    '--config',
    configPath,
    ...(spec.platform === 'win32' ? ['--win', 'nsis'] : ['--mac', 'dmg']),
    spec.arch === 'arm64' ? '--arm64' : '--x64',
    '--publish',
    'never'
  ])
}

/**
 * @param {any} input
 */
export async function produce(input) {
  const job = validateInput(input)
  if (process.platform !== job.platform) {
    throw new Error(
      `target ${job.target} 必须在 ${job.platform} 上构建，当前是 ${process.platform}`
    )
  }
  const bootstrap = join(root, '.relkit', 'runtime-bootstrap.json')
  if (!existsSync(bootstrap)) {
    throw new Error(`缺少 ${bootstrap}；先执行 relkit bootstrap build`)
  }
  const updaterPath = stagedUpdaterPath(job.target)
  if (!existsSync(updaterPath)) {
    throw new Error(
      `缺少 ${updaterPath}；先执行 node scripts/stage-relkit.mjs ${job.target}`
    )
  }
  const cli = relkitCli()
  mkdirSync(job.outputDirectory, { recursive: true })

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const { version: declared, profile: channelProfile } = selectChannel(
    root,
    job.profile
  )
  if (job.semver !== declared || pkg.version !== declared) {
    throw new Error(
      `版本不一致：relkit ${job.version}、VERSION.json ${declared}、package.json ${pkg.version}（先 npm run version:sync）`
    )
  }
  const names = artifactNames({
    artifactPrefix: channelProfile.artifactPrefix,
    semver: job.semver,
    code: job.code,
    target: job.target
  })
  const buildDirectory = join(root, '.relkit', 'build', job.target)
  rmSync(buildDirectory, { recursive: true, force: true })

  try {
    log(
      `构建 ${channelProfile.displayName} ${job.version}（${job.channel} / ${job.target}）`
    )
    buildRenderer({
      ...process.env,
      AGENTIC_CHANNEL: job.profile,
      AGENTIC_RELKIT_BOOTSTRAP: bootstrap,
      AGENTIC_RELEASE_CODE: String(job.code),
      AGENTIC_RELEASE_VERSION: job.version
    })
    const config = builderConfig({
      baseConfig: pkg.build,
      profile: job.profile,
      channelProfile,
      target: job.target,
      updaterPath,
      outputDirectory: buildDirectory
    })
    runElectronBuilder(config, job, `${buildDirectory}.builder.json`)

    const installerPath = join(job.outputDirectory, names.installer)
    const payloadPath = join(job.outputDirectory, names.payload)
    if (job.platform === 'win32') {
      const setup = single(
        buildDirectory,
        (name) => name.endsWith('.exe'),
        ' NSIS 安装包'
      )
      const tree = join(buildDirectory, 'win-unpacked')
      assertEngineInTree(tree, 'relkit-updater.exe')
      assertEngineInTree(tree, `${channelProfile.displayName}.exe`)
      copyFileSync(setup, installerPath)
      run(cli, ['payload', 'build', '--tree', tree, '--out', payloadPath])
    } else {
      const dmg = single(
        buildDirectory,
        (name) => name.endsWith('.dmg'),
        ' dmg'
      )
      const appParent = single(
        buildDirectory,
        (name) => name === 'mac' || name.startsWith('mac-'),
        ' mac 输出目录'
      )
      const app = single(appParent, (name) => name.endsWith('.app'), ' .app')
      assertEngineInTree(app, 'Contents/MacOS/relkit-updater')
      run('codesign', ['--verify', '--deep', '--strict', app])
      copyFileSync(dmg, installerPath)
      run(cli, ['payload', 'build', '--bundle', app, '--out', payloadPath])
    }
  } finally {
    // 不让工作区停在发布档身份上：本地直接 electron . 应拿到未接入更新的正式档。
    try {
      /** @type {NodeJS.ProcessEnv} */
      const env = { ...process.env, AGENTIC_CHANNEL: 'release' }
      delete env.AGENTIC_RELKIT_BOOTSTRAP
      delete env.AGENTIC_RELEASE_CODE
      delete env.AGENTIC_RELEASE_VERSION
      buildRenderer(env)
    } catch (error) {
      log(
        `恢复 out/ 失败：${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  const selectors = { 'os-arch': job.target }
  const installerId = `installer-${job.target}`
  const artifacts = [
    await describe(job.outputDirectory, names.installer, {
      id: installerId,
      kind: 'installer',
      platform: job.target,
      selectors
    }),
    await describe(job.outputDirectory, names.payload, {
      id: `payload-${job.target}`,
      kind: 'payload',
      platform: job.target,
      selectors,
      relations: { payloadOf: installerId }
    })
  ]
  return {
    schema: OUTPUT_SCHEMA,
    product: PRODUCT,
    version: job.version,
    releaseCode: job.code,
    channel: job.channel,
    changelog: changelog(job.channel, job.version),
    artifacts
  }
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const output = await produce(JSON.parse(await readStdin()))
    process.stdout.write(`${JSON.stringify(output)}\n`)
  } catch (error) {
    log(
      `失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
    )
    process.exitCode = 1
  }
}
