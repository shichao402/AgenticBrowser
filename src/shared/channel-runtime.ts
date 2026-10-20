import {
  DEFAULT_CHANNEL_NAME,
  resolveChannelName,
  resolveProfile,
  type ChannelName,
  type ChannelProfile
} from './channel-identity'

// 运行时的档位身份。构建期已经注入，这里只做收敛与集中读取，
// 业务代码不要在别处判断环境变量。

function readInjectedChannel(): unknown {
  // 单元测试与直接 tsc 运行时没有注入，用 typeof 判断而不是 try/catch，
  // 避免把真正的运行时错误一起吞掉。
  return typeof __AGENTIC_CHANNEL__ === 'undefined'
    ? undefined
    : __AGENTIC_CHANNEL__
}

function readInjectedProfile(): unknown {
  return typeof __AGENTIC_PROFILE__ === 'undefined'
    ? undefined
    : __AGENTIC_PROFILE__
}

export const currentChannel: ChannelName = resolveChannelName(
  readInjectedChannel()
)

export const currentProfile: ChannelProfile = resolveProfile(
  readInjectedProfile(),
  currentChannel
)

export const isDevChannel: boolean = currentChannel !== DEFAULT_CHANNEL_NAME

export { type ChannelName, type ChannelProfile }
