import { contextBridge, ipcRenderer } from 'electron'

import {
  IPC_CHANNELS,
  type BrowserEvent,
  type BrowserShellApi,
  type BrowserTab,
  type CapabilitySettings,
  type MonitorSnapshot,
  type ProfileSummary,
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
  listTabs: (): Promise<BrowserTab[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.listTabs),
  createTab: (url?: string): Promise<BrowserTab[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.createTab, url),
  switchTab: (tabId: string): Promise<BrowserTab[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.switchTab, tabId),
  closeTab: (tabId: string): Promise<BrowserTab[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.closeTab, tabId),
  listProfiles: (): Promise<ProfileSummary[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.listProfiles),
  createProfile: (name: string): Promise<ProfileSummary[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.createProfile, name),
  activateProfile: (profileId: string): Promise<ProfileSummary[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.activateProfile, profileId),
  deleteProfile: (profileId: string): Promise<ProfileSummary[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteProfile, profileId),
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
