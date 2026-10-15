/// <reference types="vite/client" />

import type { BrowserShellApi } from '../../shared/contracts'

declare global {
  interface Window {
    agenticBrowser: BrowserShellApi
  }
}

export {}
