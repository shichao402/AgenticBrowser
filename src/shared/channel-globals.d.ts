import type { ChannelProfile } from './channel-identity'

declare global {
  // 由 electron.vite.config.ts 在构建期通过 define 替换成字面量。
  // 声明为 const 而不是可选，是为了让使用处不必到处判空：
  // 构建期一定会注入，缺省值由 resolveChannelName/resolveProfile 兜底。
  const __AGENTIC_CHANNEL__: string
  const __AGENTIC_PROFILE__: ChannelProfile
}

export {}
