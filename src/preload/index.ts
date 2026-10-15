import { contextBridge, ipcRenderer } from 'electron'

import {
  IPC_CHANNELS,
  type BrowserEvent,
  type BrowserShellApi,
  type BrowserTab,
  type CapabilityPolicy,
  type CapabilityPolicySnapshot,
  type MonitorSnapshot,
  type ProfileSummary,
  type ReloadOptions,
  type StartupSettings
} from '../shared/contracts'

const api: BrowserShellApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.getSnapshot),
  getMonitorSnapshot: (): Promise<MonitorSnapshot> =>
    ipcRenderer.invoke(IPC_CHANNELS.getMonitorSnapshot),
  getCapabilityPolicy: (): Promise<CapabilityPolicySnapshot> =>
    ipcRenderer.invoke(IPC_CHANNELS.getCapabilityPolicy),
  setCapabilityPolicy: (
    policy: CapabilityPolicy
  ): Promise<CapabilityPolicySnapshot> =>
    ipcRenderer.invoke(IPC_CHANNELS.setCapabilityPolicy, policy),
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
  getStartupSettings: (): Promise<StartupSettings> =>
    ipcRenderer.invoke(IPC_CHANNELS.getStartupSettings),
  setOpenAtLogin: (enabled: boolean): Promise<StartupSettings> =>
    ipcRenderer.invoke(IPC_CHANNELS.setOpenAtLogin, enabled),
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
