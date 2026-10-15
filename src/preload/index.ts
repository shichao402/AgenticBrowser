import { contextBridge, ipcRenderer } from 'electron'

import {
  IPC_CHANNELS,
  type BrowserEvent,
  type BrowserShellApi,
  type CapabilitySettings,
  type MonitorSnapshot,
  type ReloadOptions
} from '../shared/contracts'

const api: BrowserShellApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.getSnapshot),
  getMonitorSnapshot: (): Promise<MonitorSnapshot> =>
    ipcRenderer.invoke(IPC_CHANNELS.getMonitorSnapshot),
  getCapabilities: (): Promise<CapabilitySettings> =>
    ipcRenderer.invoke(IPC_CHANNELS.getCapabilities),
  setCapabilities: (settings: CapabilitySettings): Promise<CapabilitySettings> =>
    ipcRenderer.invoke(IPC_CHANNELS.setCapabilities, settings),
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
