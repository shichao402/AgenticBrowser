import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'

import { currentChannel, currentProfile } from '../../shared/channel-runtime'
import { currentReleaseIdentity } from './identity'
import { installLayout, platformSelector } from './layout'
import { UpdateService } from './service'

// 把 Electron 进程的事实装配成 UpdateService。不 import electron，
// 调用方传入事实，便于入口测试替身与单元测试。

export interface UpdateHostFacts {
  executablePath: string
  platform: string
  arch: string
  userDataPath: string
  appVersion: string
  quit: () => void
  log?: (message: string) => void
}

export function isWritableDirectory(directory: string): boolean {
  try {
    accessSync(directory, constants.W_OK)
    return true
  } catch {
    return false
  }
}

export function createUpdateService(facts: UpdateHostFacts): UpdateService {
  const identity = currentReleaseIdentity()
  return new UpdateService({
    identity,
    layout: installLayout(facts.executablePath, facts.platform),
    selector: platformSelector(facts.platform, facts.arch),
    // 按档位分开：两档并排安装时各有各的引擎状态。
    dataDir: join(facts.userDataPath, 'relkit-updater', currentChannel),
    displayName: currentProfile.displayName,
    fallbackVersion: facts.appVersion,
    quit: facts.quit,
    isWritable: isWritableDirectory,
    ...(facts.log ? { log: facts.log } : {})
  })
}
