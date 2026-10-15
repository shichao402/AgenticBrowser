import { contextBridge } from 'electron'

interface FrameGlobals {
  location: {
    href: string
  }
  document: {
    readyState: string
  }
  performance: {
    now(): number
  }
}

const frame = globalThis as unknown as FrameGlobals

if (process.argv.includes('--agentic-phase0-probe')) {
  contextBridge.exposeInMainWorld('__agenticPhaseZeroProbe', {
    installedAt: frame.performance.now(),
    readyState: frame.document.readyState,
    isMainFrame: process.isMainFrame,
    href: frame.location.href
  })
}
