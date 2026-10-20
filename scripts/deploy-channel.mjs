// @ts-check
// 本地部署：把指定档位安装到固定目录。
//
// 两档走同一条路径，差别只有档位和目标目录：
//   正式档 → <安装根>/<正式档目录名>（覆盖安装，不跟随上次向导路径）
//   开发档 → <安装根>/<正式档目录名>Dev（装在正式档旁边）
//
// 各平台都用“该平台真正的安装产物”落地，不做“拷贝散文件代替安装”：
//   Windows → NSIS 安装包静默安装，有卸载登记和快捷方式
//   macOS   → electron-builder 打出的 .app 放进 /Applications，
//             等同于把应用拖入“应用程序”

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { selectChannel } from './channel-identity.mjs'
import { packageChannel, buildChannel } from './package-channel.mjs'

const root = import.meta.dirname
  ? join(import.meta.dirname, '..')
  : process.cwd()

/**
 * @param {string} command
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptionsWithStringEncoding} [options]
 */
function run(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    encoding: 'utf8',
    ...options
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`${command} 失败，退出码 ${result.status}`)
  }
  return result
}

/**
 * 安装根。两档都装在同一层，才叫并排。
 * @returns {string}
 */
function installationRoot() {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    if (!localAppData) {
      throw new Error('缺少 LOCALAPPDATA，无法确定当前用户安装根')
    }
    return localAppData
  }
  if (process.platform === 'darwin') {
    // macOS 的规范安装位就是 /Applications，正式档和开发档都放这里。
    return '/Applications'
  }
  throw new Error(`当前平台 ${process.platform} 暂不支持自动部署`)
}

/** @param {string} targetDirectory */
function stopProcessesIn(targetDirectory) {
  if (!existsSync(targetDirectory)) {
    return
  }
  if (process.platform === 'win32') {
    const script = [
      '$target = $args[0]',
      'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($target, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
    ].join('; ')
    run('powershell', ['-NoProfile', '-Command', script, targetDirectory])
    return
  }
  // macOS：只结束可执行文件位于该 .app 内的进程，不误杀同名程序。
  const listing = run('ps', ['-axo', 'pid=,command='], { stdio: 'pipe' })
  const pids = listing.stdout
    .split('\n')
    .filter((line) => line.includes(targetDirectory))
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
  for (const pid of pids) {
    run('kill', ['-TERM', String(pid)], { stdio: 'ignore' })
  }
  if (pids.length > 0) {
    console.log(`已结束目标目录内 ${pids.length} 个进程`)
  }
}

/**
 * 找到该档最新生成的安装包。
 * @param {string} outputDirectory
 * @param {string} artifactPrefix
 * @param {string} extension
 * @returns {string}
 */
function findArtifact(outputDirectory, artifactPrefix, extension) {
  if (!existsSync(outputDirectory)) {
    throw new Error(`产物目录不存在：${outputDirectory}`)
  }
  const candidates = readdirSync(outputDirectory)
    .filter(
      (name) =>
        name.startsWith(artifactPrefix) && name.endsWith(`.${extension}`)
    )
    .sort()
  const artifact = candidates.at(-1)
  if (!artifact) {
    throw new Error(
      `在 ${outputDirectory} 中没有找到 ${artifactPrefix} 的 .${extension} 产物`
    )
  }
  return join(outputDirectory, artifact)
}

/**
 * 在产物目录里递归找 .app。electron-builder 的 mac 输出层级随
 * target 与架构变化，不写死路径。
 * @param {string} directory
 * @returns {string}
 */
function findAppBundle(directory) {
  if (!existsSync(directory)) {
    throw new Error(`产物目录不存在：${directory}`)
  }
  /** @type {string[]} */
  const queue = [directory]
  while (queue.length > 0) {
    const current = /** @type {string} */ (queue.shift())
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.endsWith('.app')) {
          return full
        }
        queue.push(full)
      }
    }
  }
  throw new Error(`在 ${directory} 中没有找到 .app 产物`)
}

/**
 * Windows：NSIS 静默安装。
 *
 * /D 必须放在最后且不加引号，否则会被忽略并回落到
 * 「按显示名生成文件夹」或上次向导选过的位置。
 * @param {string} installer
 * @param {string} targetDirectory
 */
function installOnWindows(installer, targetDirectory) {
  run(installer, ['/S', `/D=${targetDirectory}`], { stdio: 'inherit' })
}

/**
 * macOS：把 .app 放进目标路径。
 *
 * 用 ditto 而不是 cp -R：ditto 会保留包内的资源分叉与扩展属性，
 * 拷完还能正常签名验证与启动。
 * @param {string} sourceApp
 * @param {string} targetDirectory
 */
function installOnMac(sourceApp, targetDirectory) {
  if (existsSync(targetDirectory)) {
    // 覆盖安装前先清掉旧包，否则 ditto 会合并出混合了新旧文件的包。
    rmSync(targetDirectory, { recursive: true, force: true })
  }
  run('ditto', [sourceApp, targetDirectory])
}

/**
 * 读回安装结果的标识，确认装上去的确实是这一档。
 * @param {string} appBundle
 * @returns {string}
 */
function readBundleIdentifier(appBundle) {
  const result = run(
    'defaults',
    ['read', join(appBundle, 'Contents', 'Info'), 'CFBundleIdentifier'],
    { stdio: 'pipe' }
  )
  return result.stdout.trim()
}

/**
 * @param {string | undefined} raw
 */
export function deploy(raw) {
  const { channel, profile } = selectChannel(root, raw)
  const installRoot = installationRoot()
  const isMac = process.platform === 'darwin'
  // macOS 的包名要比 Windows 多一层 .app 后缀，目录名本身仍用
  // installDirectoryName，保证两档在安装根里是并列的两个兄弟。
  const targetDirectory = join(
    installRoot,
    isMac ? `${profile.installDirectoryName}.app` : profile.installDirectoryName
  )
  const outputDirectory = join(root, 'release', profile.installDirectoryName)

  let failure = null
  try {
    buildChannel(channel)
    if (isMac) {
      // mac 的 dir 目标产出的就是可直接运行的 .app；装到 /Applications
      // 即等同于把应用拖进“应用程序”。identity=null 跳过本机签名，
      // 本地构建不需要开发者证书。
      packageChannel(channel, profile, [
        '-c.mac.target=dir',
        '-c.mac.identity=null'
      ])
      stopProcessesIn(targetDirectory)
      installOnMac(findAppBundle(outputDirectory), targetDirectory)
      const installedId = readBundleIdentifier(targetDirectory)
      if (installedId !== profile.appId) {
        throw new Error(
          `安装后的应用标识是 ${installedId}，与 ${channel} 档的 ${profile.appId} 不一致`
        )
      }
    } else {
      packageChannel(channel, profile)
      stopProcessesIn(targetDirectory)
      const installer = findArtifact(
        outputDirectory,
        profile.artifactPrefix,
        'exe'
      )
      installOnWindows(installer, targetDirectory)
    }
    console.log(`${channel} 档已安装到 ${targetDirectory}`)
  } catch (error) {
    failure = error
  } finally {
    if (channel === 'dev') {
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
    deploy(process.argv[2])
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
