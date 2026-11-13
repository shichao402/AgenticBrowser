# AgenticBrowser API 参考

> 本文件由脚本自动生成，请勿手工编辑。

生成命令：`npm run docs:api`

真源文件：

- `src/shared/contracts.ts`
- `src/preload/index.ts`
- `src/preload/strategy-bootstrap.ts`
- `src/main/strategy-runtime.ts`

生成器使用的 TypeScript 版本：6.0.3

## 渲染进程桥 `window.agenticBrowser`

### `BrowserShellApi` 全部方法

通过 `contextBridge.exposeInMainWorld` 暴露到渲染进程主 world，在 renderer
DevTools Console 中可直接调用。

共 37 个成员，按源码声明顺序排列。

#### `getSnapshot`

```typescript
getSnapshot(): Promise<BrowserSnapshot>
```

源码位置：`src/shared/contracts.ts:646`

无参数。

##### 字段表 `BrowserSnapshot`

| 字段         | 类型                   | 可选 |
| ------------ | ---------------------- | ---- |
| `url`        | `string`               | 否   |
| `title`      | `string`               | 否   |
| `loading`    | `boolean`              | 否   |
| `responsive` | `boolean`              | 否   |
| `generation` | `number`               | 否   |
| `lastEvent`  | `BrowserEvent \| null` | 否   |
| `health`     | `PageHealthSnapshot`   | 否   |
| `recovery`   | `RecoverySnapshot`     | 否   |

#### `getMonitorSnapshot`

```typescript
getMonitorSnapshot(): Promise<MonitorSnapshot>
```

源码位置：`src/shared/contracts.ts:647`

无参数。

##### 字段表 `MonitorSnapshot`

| 字段                   | 类型                             | 可选 |
| ---------------------- | -------------------------------- | ---- |
| `generatedAt`          | `string`                         | 否   |
| `browser`              | `BrowserSnapshot`                | 否   |
| `projectRuntime`       | `ProjectRuntimeSnapshot \| null` | 否   |
| `projectRuntimes`      | `ProjectRuntimeSnapshot[]`       | 否   |
| `activeProjectCount`   | `number`                         | 否   |
| `pausedProjectCount`   | `number`                         | 否   |
| `queuedProjectCount`   | `number`                         | 否   |
| `browserEventCount`    | `number`                         | 否   |
| `activePageCount`      | `number`                         | 否   |
| `activeStrategyCount`  | `number`                         | 否   |
| `strategies`           | `StrategyRuntimeSnapshot`        | 否   |
| `totalCpuPercent`      | `number`                         | 否   |
| `totalWorkingSetBytes` | `number`                         | 否   |
| `processes`            | `ProcessMetric[]`                | 否   |
| `downloads`            | `DownloadSummary`                | 否   |

#### `getCapabilityPolicy`

```typescript
getCapabilityPolicy(): Promise<CapabilityPolicySnapshot>
```

源码位置：`src/shared/contracts.ts:648`

无参数。

##### 字段表 `CapabilityPolicySnapshot`

| 字段            | 类型                 | 可选 |
| --------------- | -------------------- | ---- |
| `policy`        | `CapabilityPolicy`   | 否   |
| `currentOrigin` | `string \| null`     | 否   |
| `effective`     | `CapabilitySettings` | 否   |

#### `setCapabilityPolicy`

```typescript
setCapabilityPolicy(policy: CapabilityPolicy): Promise<CapabilityPolicySnapshot>
```

源码位置：`src/shared/contracts.ts:649`

| 参数     | 类型               | 可选 |
| -------- | ------------------ | ---- |
| `policy` | `CapabilityPolicy` | 否   |

#### `listTabs`

```typescript
listTabs(): Promise<BrowserTab[]>
```

源码位置：`src/shared/contracts.ts:652`

无参数。

#### `createTab`

```typescript
createTab(url?: string): Promise<BrowserTab[]>
```

源码位置：`src/shared/contracts.ts:653`

| 参数  | 类型     | 可选 |
| ----- | -------- | ---- |
| `url` | `string` | 是   |

#### `switchTab`

```typescript
switchTab(tabId: string): Promise<BrowserTab[]>
```

源码位置：`src/shared/contracts.ts:654`

| 参数    | 类型     | 可选 |
| ------- | -------- | ---- |
| `tabId` | `string` | 否   |

#### `closeTab`

```typescript
closeTab(tabId: string): Promise<BrowserTab[]>
```

源码位置：`src/shared/contracts.ts:655`

| 参数    | 类型     | 可选 |
| ------- | -------- | ---- |
| `tabId` | `string` | 否   |

#### `listProfiles`

```typescript
listProfiles(): Promise<ProfileSummary[]>
```

源码位置：`src/shared/contracts.ts:656`

无参数。

#### `createProfile`

```typescript
createProfile(name: string): Promise<ProfileSummary[]>
```

源码位置：`src/shared/contracts.ts:657`

| 参数   | 类型     | 可选 |
| ------ | -------- | ---- |
| `name` | `string` | 否   |

#### `activateProfile`

```typescript
activateProfile(profileId: string): Promise<ProfileSummary[]>
```

源码位置：`src/shared/contracts.ts:658`

| 参数        | 类型     | 可选 |
| ----------- | -------- | ---- |
| `profileId` | `string` | 否   |

#### `deleteProfile`

```typescript
deleteProfile(profileId: string): Promise<ProfileSummary[]>
```

源码位置：`src/shared/contracts.ts:659`

| 参数        | 类型     | 可选 |
| ----------- | -------- | ---- |
| `profileId` | `string` | 否   |

#### `getProjectWorkspace`

```typescript
getProjectWorkspace(): Promise<ProjectWorkspaceSnapshot>
```

源码位置：`src/shared/contracts.ts:660`

无参数。

##### 字段表 `ProjectWorkspaceSnapshot`

| 字段                  | 类型                          | 可选 |
| --------------------- | ----------------------------- | ---- |
| `activeProjectId`     | `string \| null`              | 否   |
| `projects`            | `ProjectDefinition[]`         | 否   |
| `runtimes`            | `ProjectRuntimeRecord[]`      | 否   |
| `strategyResolutions` | `ProjectStrategyResolution[]` | 否   |

#### `installAutomationPlayground`

```typescript
installAutomationPlayground(profileId: string): Promise<AutomationPlaygroundInstallResult>
```

源码位置：`src/shared/contracts.ts:661`

| 参数        | 类型     | 可选 |
| ----------- | -------- | ---- |
| `profileId` | `string` | 否   |

##### 字段表 `AutomationPlaygroundInstallResult`

| 字段                | 类型                        | 可选 |
| ------------------- | --------------------------- | ---- |
| `projectWorkspace`  | `ProjectWorkspaceSnapshot`  | 否   |
| `strategyWorkspace` | `StrategyWorkspaceSnapshot` | 否   |

#### `saveProject`

```typescript
saveProject(draft: ProjectDraft): Promise<ProjectWorkspaceSnapshot>
```

源码位置：`src/shared/contracts.ts:664`

| 参数    | 类型           | 可选 |
| ------- | -------------- | ---- |
| `draft` | `ProjectDraft` | 否   |

#### `setActiveProject`

```typescript
setActiveProject(projectId: string): Promise<ProjectWorkspaceSnapshot>
```

源码位置：`src/shared/contracts.ts:665`

| 参数        | 类型     | 可选 |
| ----------- | -------- | ---- |
| `projectId` | `string` | 否   |

#### `deleteProject`

```typescript
deleteProject(projectId: string): Promise<ProjectWorkspaceSnapshot>
```

源码位置：`src/shared/contracts.ts:666`

| 参数        | 类型     | 可选 |
| ----------- | -------- | ---- |
| `projectId` | `string` | 否   |

#### `startProjectRuntime`

```typescript
startProjectRuntime(projectId: string): Promise<ProjectWorkspaceSnapshot>
```

源码位置：`src/shared/contracts.ts:667`

| 参数        | 类型     | 可选 |
| ----------- | -------- | ---- |
| `projectId` | `string` | 否   |

#### `pauseProjectRuntime`

```typescript
pauseProjectRuntime(projectId: string): Promise<ProjectWorkspaceSnapshot>
```

源码位置：`src/shared/contracts.ts:668`

| 参数        | 类型     | 可选 |
| ----------- | -------- | ---- |
| `projectId` | `string` | 否   |

#### `resumeProjectRuntime`

```typescript
resumeProjectRuntime(projectId: string): Promise<ProjectWorkspaceSnapshot>
```

源码位置：`src/shared/contracts.ts:669`

| 参数        | 类型     | 可选 |
| ----------- | -------- | ---- |
| `projectId` | `string` | 否   |

#### `stopProjectRuntime`

```typescript
stopProjectRuntime(projectId: string): Promise<ProjectWorkspaceSnapshot>
```

源码位置：`src/shared/contracts.ts:670`

| 参数        | 类型     | 可选 |
| ----------- | -------- | ---- |
| `projectId` | `string` | 否   |

#### `getStartupSettings`

```typescript
getStartupSettings(): Promise<StartupSettings>
```

源码位置：`src/shared/contracts.ts:671`

无参数。

##### 字段表 `StartupSettings`

| 字段                | 类型      | 可选 |
| ------------------- | --------- | ---- |
| `supported`         | `boolean` | 否   |
| `openAtLogin`       | `boolean` | 否   |
| `managedByWatchdog` | `boolean` | 否   |

#### `setOpenAtLogin`

```typescript
setOpenAtLogin(enabled: boolean): Promise<StartupSettings>
```

源码位置：`src/shared/contracts.ts:672`

| 参数      | 类型      | 可选 |
| --------- | --------- | ---- |
| `enabled` | `boolean` | 否   |

#### `getUpdateStatus`

```typescript
getUpdateStatus(): Promise<UpdateStatus>
```

源码位置：`src/shared/contracts.ts:673`

无参数。

##### 字段表 `UpdateStatus`

| 字段             | 类型                     | 可选 |
| ---------------- | ------------------------ | ---- |
| `enabled`        | `boolean`                | 否   |
| `channel`        | `string \| null`         | 否   |
| `currentVersion` | `string`                 | 否   |
| `currentCode`    | `number \| null`         | 否   |
| `phase`          | `UpdatePhase`            | 否   |
| `message`        | `string \| null`         | 否   |
| `available`      | `UpdateOffer \| null`    | 否   |
| `progress`       | `UpdateProgress \| null` | 否   |
| `manualUrl`      | `string \| null`         | 否   |
| `checkedAt`      | `string \| null`         | 否   |

#### `checkForUpdates`

```typescript
checkForUpdates(): Promise<UpdateStatus>
```

源码位置：`src/shared/contracts.ts:674`

无参数。

#### `downloadUpdate`

```typescript
downloadUpdate(): Promise<UpdateStatus>
```

源码位置：`src/shared/contracts.ts:675`

无参数。

#### `installUpdate`

```typescript
installUpdate(): Promise<UpdateStatus>
```

源码位置：`src/shared/contracts.ts:676`

无参数。

#### `onUpdateStatus`

```typescript
onUpdateStatus(listener: (status: UpdateStatus) => void): () => void
```

源码位置：`src/shared/contracts.ts:677`

| 参数       | 类型                             | 可选 |
| ---------- | -------------------------------- | ---- |
| `listener` | `(status: UpdateStatus) => void` | 否   |

#### `getStrategyWorkspace`

```typescript
getStrategyWorkspace(): Promise<StrategyWorkspaceSnapshot>
```

源码位置：`src/shared/contracts.ts:678`

无参数。

##### 字段表 `StrategyWorkspaceSnapshot`

| 字段                            | 类型                   | 可选 |
| ------------------------------- | ---------------------- | ---- |
| `strategies`                    | `StrategyDefinition[]` | 否   |
| `developmentAllowedStrategyIds` | `string[]`             | 否   |

#### `saveStrategy`

```typescript
saveStrategy(draft: StrategyDraft): Promise<StrategyWorkspaceSnapshot>
```

源码位置：`src/shared/contracts.ts:679`

| 参数    | 类型            | 可选 |
| ------- | --------------- | ---- |
| `draft` | `StrategyDraft` | 否   |

#### `setStrategyEnabled`

```typescript
setStrategyEnabled(strategyId: string, enabled: boolean): Promise<StrategyWorkspaceSnapshot>
```

源码位置：`src/shared/contracts.ts:680`

| 参数         | 类型      | 可选 |
| ------------ | --------- | ---- |
| `strategyId` | `string`  | 否   |
| `enabled`    | `boolean` | 否   |

#### `setStrategyAllowed`

```typescript
setStrategyAllowed(strategyId: string, allowed: boolean): Promise<StrategyWorkspaceSnapshot>
```

源码位置：`src/shared/contracts.ts:684`

| 参数         | 类型      | 可选 |
| ------------ | --------- | ---- |
| `strategyId` | `string`  | 否   |
| `allowed`    | `boolean` | 否   |

#### `deleteStrategy`

```typescript
deleteStrategy(strategyId: string): Promise<StrategyWorkspaceSnapshot>
```

源码位置：`src/shared/contracts.ts:688`

| 参数         | 类型     | 可选 |
| ------------ | -------- | ---- |
| `strategyId` | `string` | 否   |

#### `navigate`

```typescript
navigate(url: string): Promise<BrowserSnapshot>
```

源码位置：`src/shared/contracts.ts:689`

| 参数  | 类型     | 可选 |
| ----- | -------- | ---- |
| `url` | `string` | 否   |

#### `reload`

```typescript
reload(options: ReloadOptions): Promise<BrowserSnapshot>
```

源码位置：`src/shared/contracts.ts:690`

| 参数      | 类型            | 可选 |
| --------- | --------------- | ---- |
| `options` | `ReloadOptions` | 否   |

#### `setPageViewsVisible`

```typescript
setPageViewsVisible(visible: boolean): Promise<void>
```

源码位置：`src/shared/contracts.ts:691`

| 参数      | 类型      | 可选 |
| --------- | --------- | ---- |
| `visible` | `boolean` | 否   |

#### `onBrowserEvent`

```typescript
onBrowserEvent(listener: (event: BrowserEvent) => void): () => void
```

源码位置：`src/shared/contracts.ts:692`

| 参数       | 类型                            | 可选 |
| ---------- | ------------------------------- | ---- |
| `listener` | `(event: BrowserEvent) => void` | 否   |

## Strategy 宿主对象 `agenticStrategy`

### `StrategyHostApi` 全部成员

仅在 Strategy 脚本运行的页面隔离 world 中可用，与渲染进程主 world
不是同一上下文。

共 8 个成员，按源码声明顺序排列。

#### `config`

```typescript
readonly config: Record<string, JsonValue>
```

源码位置：`src/shared/contracts.ts:632`

#### `log`

```typescript
log(message: string, data?: JsonValue): Promise<void>
```

源码位置：`src/shared/contracts.ts:633`

| 参数      | 类型        | 可选 |
| --------- | ----------- | ---- |
| `message` | `string`    | 否   |
| `data`    | `JsonValue` | 是   |

#### `debug`

```typescript
debug(message: string, data?: JsonValue): Promise<void>
```

源码位置：`src/shared/contracts.ts:634`

| 参数      | 类型        | 可选 |
| --------- | ----------- | ---- |
| `message` | `string`    | 否   |
| `data`    | `JsonValue` | 是   |

#### `warn`

```typescript
warn(message: string, data?: JsonValue): Promise<void>
```

源码位置：`src/shared/contracts.ts:635`

| 参数      | 类型        | 可选 |
| --------- | ----------- | ---- |
| `message` | `string`    | 否   |
| `data`    | `JsonValue` | 是   |

#### `error`

```typescript
error(message: string, data?: JsonValue): Promise<void>
```

源码位置：`src/shared/contracts.ts:636`

| 参数      | 类型        | 可选 |
| --------- | ----------- | ---- |
| `message` | `string`    | 否   |
| `data`    | `JsonValue` | 是   |

#### `emit`

```typescript
emit(name: string, payload?: JsonValue): Promise<void>
```

源码位置：`src/shared/contracts.ts:637`

| 参数      | 类型        | 可选 |
| --------- | ----------- | ---- |
| `name`    | `string`    | 否   |
| `payload` | `JsonValue` | 是   |

#### `request`

```typescript
request(request: StrategyNetworkRequest): Promise<StrategyNetworkResponse>
```

源码位置：`src/shared/contracts.ts:638`

| 参数      | 类型                     | 可选 |
| --------- | ------------------------ | ---- |
| `request` | `StrategyNetworkRequest` | 否   |

##### 字段表 `StrategyNetworkResponse`

| 字段      | 类型                     | 可选 |
| --------- | ------------------------ | ---- |
| `url`     | `string`                 | 否   |
| `status`  | `number`                 | 否   |
| `headers` | `Record<string, string>` | 否   |
| `body`    | `string`                 | 否   |

#### `evaluateMainWorld`

```typescript
evaluateMainWorld(source: string): Promise<unknown>
```

源码位置：`src/shared/contracts.ts:639`

| 参数     | 类型     | 可选 |
| -------- | -------- | ---- |
| `source` | `string` | 否   |

## 事件、权限与限额

### `BrowserEventType` 事件

源码位置：`src/shared/contracts.ts:47`

| 事件名                        | 源码行 |
| ----------------------------- | ------ |
| `'created'`                   | 48     |
| `'navigation-started'`        | 49     |
| `'navigation-finished'`       | 50     |
| `'load-started'`              | 51     |
| `'load-finished'`             | 52     |
| `'load-failed'`               | 53     |
| `'unresponsive'`              | 54     |
| `'responsive'`                | 55     |
| `'renderer-gone'`             | 56     |
| `'recreated'`                 | 57     |
| `'checkpoint-saved'`          | 58     |
| `'checkpoint-failed'`         | 59     |
| `'health-changed'`            | 60     |
| `'recovery-scheduled'`        | 61     |
| `'recovery-started'`          | 62     |
| `'recovery-succeeded'`        | 63     |
| `'circuit-open'`              | 64     |
| `'popup-blocked'`             | 65     |
| `'popup-routed'`              | 66     |
| `'download-blocked'`          | 67     |
| `'download-started'`          | 68     |
| `'download-progress'`         | 69     |
| `'download-completed'`        | 70     |
| `'download-failed'`           | 71     |
| `'strategy-started'`          | 72     |
| `'strategy-ready'`            | 73     |
| `'strategy-log'`              | 74     |
| `'strategy-event'`            | 75     |
| `'strategy-failed'`           | 76     |
| `'strategy-heartbeat-missed'` | 77     |
| `'strategy-quarantined'`      | 78     |
| `'strategy-reloaded'`         | 79     |
| `'project-runtime-started'`   | 80     |
| `'project-runtime-paused'`    | 81     |
| `'project-runtime-resumed'`   | 82     |
| `'project-runtime-stopped'`   | 83     |
| `'project-runtime-failed'`    | 84     |
| `'filter-hit'`                | 85     |
| `'filter-css-applied'`        | 86     |

### 联合类型与字面量

#### `StrategyRunAt`

源码位置：`src/shared/contracts.ts:493`

| 字面量             | 源码行 |
| ------------------ | ------ |
| `'document-start'` | 493    |
| `'document-end'`   | 493    |
| `'document-idle'`  | 493    |

#### `StrategyFrameScope`

源码位置：`src/shared/contracts.ts:495`

| 字面量  | 源码行 |
| ------- | ------ |
| `'top'` | 495    |
| `'all'` | 495    |

#### `StrategyPermission`

源码位置：`src/shared/contracts.ts:497`

| 字面量                 | 源码行 |
| ---------------------- | ------ |
| `'dom.read'`           | 498    |
| `'dom.write'`          | 499    |
| `'dom.click'`          | 500    |
| `'config.read'`        | 501    |
| `'log'`                | 502    |
| `'project.emit-event'` | 503    |
| `'network.request'`    | 504    |
| `'main-world'`         | 505    |

#### `StrategyLogLevel`

源码位置：`src/shared/contracts.ts:599`

| 字面量    | 源码行 |
| --------- | ------ |
| `'debug'` | 599    |
| `'info'`  | 599    |
| `'warn'`  | 599    |
| `'error'` | 599    |

#### `StrategyHostMethod`

源码位置：`src/shared/contracts.ts:615`

| 字面量              | 源码行 |
| ------------------- | ------ |
| `'log'`             | 616    |
| `'emit-event'`      | 616    |
| `'network-request'` | 616    |
| `'main-world-eval'` | 616    |

#### `StrategyRuntimeStatus`

源码位置：`src/shared/contracts.ts:547`

| 字面量        | 源码行 |
| ------------- | ------ |
| `'issued'`    | 548    |
| `'scheduled'` | 548    |
| `'starting'`  | 548    |
| `'running'`   | 548    |
| `'failed'`    | 548    |

#### `StrategyRuntimeSignalType`

源码位置：`src/shared/contracts.ts:590`

| 字面量        | 源码行 |
| ------------- | ------ |
| `'installed'` | 591    |
| `'started'`   | 591    |
| `'ready'`     | 591    |
| `'heartbeat'` | 591    |
| `'failed'`    | 591    |

#### `WorkflowFailureCategory`

源码位置：`src/shared/contracts.ts:247`

| 字面量             | 源码行 |
| ------------------ | ------ |
| `'network'`        | 248    |
| `'timeout'`        | 249    |
| `'authentication'` | 250    |
| `'page-changed'`   | 251    |
| `'renderer'`       | 252    |
| `'disk'`           | 253    |
| `'cancelled'`      | 254    |
| `'unknown'`        | 255    |

#### `ProjectRuntimeMode`

源码位置：`src/shared/contracts.ts:207`

| 字面量        | 源码行 |
| ------------- | ------ |
| `'manual'`    | 208    |
| `'autostart'` | 208    |
| `'resident'`  | 208    |
| `'schedule'`  | 208    |

#### `ProjectRuntimeStatus`

源码位置：`src/shared/contracts.ts:363`

| 字面量         | 源码行 |
| -------------- | ------ |
| `'queued'`     | 364    |
| `'starting'`   | 365    |
| `'running'`    | 366    |
| `'waiting'`    | 367    |
| `'recovering'` | 368    |
| `'paused'`     | 369    |
| `'failed'`     | 370    |
| `'completed'`  | 371    |
| `'cancelled'`  | 372    |

#### `DownloadRecordStatus`

源码位置：`src/shared/contracts.ts:405`

| 字面量          | 源码行 |
| --------------- | ------ |
| `'reserved'`    | 406    |
| `'downloading'` | 406    |
| `'completed'`   | 406    |
| `'failed'`      | 406    |
| `'cancelled'`   | 406    |

#### `PageHealthStatus`

源码位置：`src/shared/contracts.ts:110`

| 字面量           | 源码行 |
| ---------------- | ------ |
| `'starting'`     | 111    |
| `'healthy'`      | 111    |
| `'degraded'`     | 111    |
| `'unresponsive'` | 111    |
| `'stopped'`      | 111    |

#### `ContentFilterResourceType`

源码位置：`src/shared/contracts.ts:225`

| 字面量         | 源码行 |
| -------------- | ------ |
| `'stylesheet'` | 226    |
| `'image'`      | 226    |
| `'media'`      | 226    |
| `'font'`       | 226    |
| `'script'`     | 226    |
| `'xhr'`        | 226    |
| `'other'`      | 226    |

#### `WorkflowNode` 的 kind 取值

工作流节点类型由可辨识联合的 `kind` 字段表达，没有独立的联合类型别名。

源码位置：`src/shared/contracts.ts:266`

| kind             | 源码行 |
| ---------------- | ------ |
| `navigate`       | 268    |
| `wait-for-event` | 273    |
| `delay`          | 278    |
| `complete`       | 283    |

### 宿主方法所需权限

权限来自 manifest 的 `permissions` 字段，未声明对应权限时调用会抛错。

| 宿主方法          | 所需权限             |
| ----------------- | -------------------- |
| `log`             | `log`                |
| `emit-event`      | `project.emit-event` |
| `network-request` | `network.request`    |
| `main-world-eval` | `main-world`         |

### 限额常量

下列数值由源码常量读取，数值变更会导致校验失败，需要重新生成。

| 常量                      | 数值   | 位置                     |
| ------------------------- | ------ | ------------------------ |
| `INSTALL_TIMEOUT_MS`      | 5000   | `strategy-runtime.ts:24` |
| `MAX_HOST_PAYLOAD_BYTES`  | 131072 | `strategy-runtime.ts:25` |
| `MAX_LOG_MESSAGE_LENGTH`  | 2000   | `strategy-runtime.ts:26` |
| `FIRST_STRATEGY_WORLD_ID` | 1001   | `strategy-runtime.ts:23` |

各常量含义：

- `INSTALL_TIMEOUT_MS`：bootstrap 安装超时
- `MAX_HOST_PAYLOAD_BYTES`：宿主调用 payload 字节上限
- `MAX_LOG_MESSAGE_LENGTH`：日志消息与失败原因长度上限
- `FIRST_STRATEGY_WORLD_ID`：Strategy 隔离 world 起始编号

### 显式错误文案

下列文案来自源码中的 `throw new Error(...)`，可用于识别失败原因。

含模板插值的文案无法逐字复述，仅给出位置与该文案的稳定前缀。

| 错误文案                                   | 位置                       |
| ------------------------------------------ | -------------------------- |
| `Strategy 宿主调用格式无效`                | `strategy-runtime.ts:199`  |
| `Strategy 执行令牌已失效`                  | `strategy-runtime.ts:203`  |
| `无法创建唯一 Strategy 执行令牌`           | `strategy-runtime.ts:349`  |
| `Strategy 日志参数无效`                    | `strategy-runtime.ts:391`  |
| `Strategy 日志级别或内容无效`              | `strategy-runtime.ts:402`  |
| `Strategy 领域事件名称无效`                | `strategy-runtime.ts:422`  |
| `Strategy 领域事件处理结果不是 JSON 值`    | `strategy-runtime.ts:440`  |
| `Strategy 网络请求格式无效`                | `strategy-runtime.ts:451`  |
| `Strategy 网络请求执行器不可用`            | `strategy-runtime.ts:461`  |
| `main-world 执行参数无效`                  | `strategy-runtime.ts:481`  |
| `Strategy main-world 执行未授权或源码无效` | `strategy-bootstrap.ts:87` |

#### 含插值的文案

- `strategy-runtime.ts:383`：以「Strategy」开头，中间含动态值
- `strategy-runtime.ts:458`：以「Strategy 网络请求未命中
allowlist：」开头，中间含动态值

### 覆盖率统计

| 项目                    | 数量 | 真源                      |
| ----------------------- | ---- | ------------------------- |
| `BrowserShellApi` 方法  | 37   | `src/shared/contracts.ts` |
| `StrategyHostApi` 成员  | 8    | `src/shared/contracts.ts` |
| `IPC_CHANNELS` 通道     | 37   | `src/shared/contracts.ts` |
| `BrowserEventType` 事件 | 39   | `src/shared/contracts.ts` |

渲染进程桥方法数与 IPC 通道数应相等，当前分别为 37 与 37。

### 注入对象交叉校验

`agenticStrategy` 由 `src/preload/strategy-bootstrap.ts` 的模板字符串注入，与
`StrategyHostApi` 的成员必须完全一致。

| 注入成员            | 接口已声明 |
| ------------------- | ---------- |
| `config`            | 是         |
| `log`               | 是         |
| `debug`             | 是         |
| `warn`              | 是         |
| `error`             | 是         |
| `emit`              | 是         |
| `request`           | 是         |
| `evaluateMainWorld` | 是         |
