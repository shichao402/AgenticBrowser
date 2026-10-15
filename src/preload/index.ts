import { contextBridge, ipcRenderer } from 'electron'

import {
  IPC_CHANNELS,
  type BrowserEvent,
  type BrowserShellApi,
  type ReloadOptions
} from '../shared/contracts'

const api: BrowserShellApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.getSnapshot),
  navigate: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.navigate, url),
  reload: (options: ReloadOptions) => ipcRenderer.invoke(IPC_CHANNELS.reload, options),
  onBrowserEvent: (listener: (event: BrowserEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, browserEvent: BrowserEvent): void => {
      listener(browserEvent)
    }

    ipcRenderer.on(IPC_CHANNELS.browserEvent, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.browserEvent, wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('agenticBrowser', api)
