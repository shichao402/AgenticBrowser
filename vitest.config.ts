import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // 只统计真正承载逻辑的源码。入口编排、Electron 集成与冒烟宿主依赖真实
      // 窗口和进程派生，由冒烟场景覆盖，计入单元测试覆盖率只会稀释信号。
      exclude: [
        'src/main/index.ts',
        'src/main/smoke-runners.ts',
        'src/main/smoke-runtime.ts',
        'src/main/smoke-flags.ts',
        'src/renderer/**',
        'src/shared/contracts.ts',
        'src/preload/**'
      ],
      // 阈值取当前实测值的下沿，用于防止覆盖率回退。实测约
      // 54.3 / 63.11 / 61.1 / 54.37。
      thresholds: {
        statements: 53,
        branches: 62,
        functions: 61,
        lines: 53
      }
    }
  }
})
