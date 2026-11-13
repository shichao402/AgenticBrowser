import { posix, win32 } from 'node:path'

import { ErrorCode } from './gen/updater/v2/updater_pb'

// 本机安装形态：安装根在哪、主程序与引擎相对安装根在哪、哪些位置装不了。
// 全是纯函数，平台作为参数传入，便于在任一系统上测试。
//
// 布局与 scripts/relkit_producer.mjs 的 extraFiles 一一对应：
//   macOS：  <X>.app/Contents/MacOS/<X> 与 <X>.app/Contents/MacOS/relkit-updater
//   Windows：<安装目录>/<X>.exe 与 <安装目录>/relkit-updater.exe

export type UpdatePlatform = 'darwin' | 'win32'

export interface InstallLayout {
  platform: UpdatePlatform
  /** macOS 为整个 .app，Windows 为 exe 所在目录。 */
  installRoot: string
  executableRelpath: string
  sidecarRelpath: string
  /** 本版本自带的引擎；宿主只调用这一份。 */
  sidecarPath: string
  /** 原地替换时保留旧树里的条目（相对安装根）。 */
  preserve: string[]
}

export const MAC_SIDECAR_RELPATH = 'Contents/MacOS/relkit-updater'
export const WINDOWS_SIDECAR_RELPATH = 'relkit-updater.exe'

export function isUpdatePlatform(platform: string): platform is UpdatePlatform {
  return platform === 'darwin' || platform === 'win32'
}

/** 从运行中的可执行文件推出安装布局；推不出（开发运行、非常规布局）返回 null。 */
export function installLayout(
  executablePath: string,
  platform: string
): InstallLayout | null {
  if (platform === 'darwin') {
    const marker = '.app/Contents/MacOS/'
    const index = executablePath.lastIndexOf(marker)
    if (index < 0) {
      return null
    }
    const installRoot = executablePath.slice(0, index + '.app'.length)
    const name = executablePath.slice(index + marker.length)
    if (name.length === 0 || name.includes('/')) {
      return null
    }
    return {
      platform,
      installRoot,
      executableRelpath: `Contents/MacOS/${name}`,
      sidecarRelpath: MAC_SIDECAR_RELPATH,
      sidecarPath: posix.join(installRoot, MAC_SIDECAR_RELPATH),
      // .app 是密封包，引擎对 BUNDLE 原地替换拒收 preserve。
      preserve: []
    }
  }
  if (platform === 'win32') {
    const name = win32.basename(executablePath)
    if (!/\.exe$/i.test(name) || /^electron\.exe$/i.test(name)) {
      return null
    }
    const installRoot = win32.dirname(executablePath)
    return {
      platform,
      installRoot,
      executableRelpath: name,
      sidecarRelpath: WINDOWS_SIDECAR_RELPATH,
      sidecarPath: win32.join(installRoot, WINDOWS_SIDECAR_RELPATH),
      // NSIS 安装时才生成卸载程序，payload 里没有，替换时必须留下。
      preserve: [`Uninstall ${name}`]
    }
  }
  return null
}

/**
 * 这个位置能不能原地更新；能返回 null，否则返回给用户看的原因。
 * 引擎在旧树旁写出新树再换名，所以要的是安装根所在目录可写。
 */
export function locationProblem(
  layout: InstallLayout,
  isWritable: (directory: string) => boolean
): string | null {
  if (layout.platform === 'darwin') {
    const root = layout.installRoot
    if (root.includes('/AppTranslocation/')) {
      return '应用正以 macOS 隔离副本运行，无法在应用内更新。请把应用移到“应用程序”文件夹后再从那里打开。'
    }
    if (root.startsWith('/Volumes/')) {
      return '应用正从安装盘运行，无法在应用内更新。请把应用拖到“应用程序”文件夹后再从那里打开。'
    }
    if (!isWritable(posix.dirname(root))) {
      return `没有权限写入 ${posix.dirname(root)}，无法在应用内更新。请移到“应用程序”文件夹或下载安装程序手动更新。`
    }
    return null
  }
  if (!isWritable(win32.dirname(layout.installRoot))) {
    return `没有权限写入 ${win32.dirname(layout.installRoot)}，无法在应用内更新。请下载安装程序手动更新。`
  }
  if (!isWritable(layout.installRoot)) {
    return `没有权限写入 ${layout.installRoot}，无法在应用内更新。请下载安装程序手动更新。`
  }
  return null
}

/** 本机的 os-arch 选择器，取值与 producer 的 TARGETS 一致；没有对应产物返回 null。 */
export function platformSelector(
  platform: string,
  arch: string
): string | null {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64'
  if (platform === 'darwin' && arch === 'x64') return 'darwin-amd64'
  if (platform === 'win32' && arch === 'x64') return 'windows-amd64'
  return null
}

const ERROR_TEXT: Partial<Record<ErrorCode, string>> = {
  [ErrorCode.NETWORK]: '连不上更新服务器，请检查网络后重试。',
  [ErrorCode.SIGNATURE]: '更新签名校验失败，已拒绝这次更新。',
  [ErrorCode.ROLLBACK_REJECTED]: '服务器返回的版本比当前旧，已拒绝。',
  [ErrorCode.SELECTOR_NO_MATCH]: '服务器上没有适合本机系统与架构的更新包。',
  [ErrorCode.DISK]: '磁盘空间不足或无法写入，更新未完成。',
  [ErrorCode.PERMISSION_DENIED]:
    '没有权限写入安装目录，请下载安装程序手动更新。',
  [ErrorCode.OCCUPIED]: '安装目录被占用，请关闭其他正在运行的实例后重试。',
  [ErrorCode.PROTOCOL_MISMATCH]: '更新组件与应用不匹配，请重新下载安装程序。',
  [ErrorCode.UPDATER_TOO_OLD]: '更新组件版本过旧，请重新下载安装程序。',
  [ErrorCode.UPDATER_TOO_NEW]: '更新组件版本过新，请重新下载安装程序。',
  [ErrorCode.PLAN_TAMPERED]: '更新计划校验失败，请重新检查更新。',
  [ErrorCode.PLAN_EXPIRED]: '更新计划已过期，请重新检查更新。',
  [ErrorCode.PLAN_UNKNOWN]: '找不到这次更新计划，请重新检查更新。',
  [ErrorCode.PLAN_NOT_DOWNLOADED]: '更新包还没下载完成，请先下载。',
  [ErrorCode.PROFILE_INVALID]: '内置的更新配置无效，请重新下载安装程序。',
  [ErrorCode.CHANNEL_NOT_ALLOWED]: '服务器不允许当前更新渠道。',
  [ErrorCode.CANCELED]: '更新已取消。',
  [ErrorCode.SIDECAR_NOT_FOUND]: '安装包缺少更新组件，请重新下载安装程序。',
  [ErrorCode.LAYOUT_UNSUPPORTED]:
    '当前安装方式不支持应用内更新，请下载安装程序。',
  [ErrorCode.INSTALLER_FAILED]: '安装程序执行失败，请下载安装程序手动更新。'
}

/** 引擎错误码到中文的映射；未知码回落到引擎原文。 */
export function describeError(code: ErrorCode, message: string): string {
  const text = ERROR_TEXT[code]
  if (text) {
    return text
  }
  return message.trim().length > 0 ? `更新失败：${message}` : '更新失败。'
}
