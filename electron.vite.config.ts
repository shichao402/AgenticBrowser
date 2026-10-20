import { resolve } from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

import { selectChannel } from './scripts/channel-identity.mjs'

// 档位在构建期决定，写进产物后运行时不再重新判断。
// 环境变量只在这一次构建里有效，所以不会出现"构建是开发档、
// 运行时读到的却是另一档"的错位。
const root = resolve(import.meta.dirname)
const { channel, profile } = selectChannel(root, process.env.AGENTIC_CHANNEL)

const channelDefinition = {
  __AGENTIC_CHANNEL__: JSON.stringify(channel),
  __AGENTIC_PROFILE__: JSON.stringify(profile)
}

export default defineConfig({
  main: {
    define: channelDefinition,
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          watchdog: resolve('src/main/watchdog.ts')
        }
      }
    }
  },
  preload: {
    define: channelDefinition,
    build: {
      rollupOptions: {
        input: {
          shell: resolve('src/preload/index.ts'),
          'strategy-bootstrap': resolve('src/preload/strategy-bootstrap.ts')
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    define: channelDefinition,
    root: resolve('src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve('src/renderer/index.html')
      }
    }
  }
})
