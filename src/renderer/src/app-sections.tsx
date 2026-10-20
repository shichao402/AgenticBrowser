import type {
  ProjectWorkspaceSnapshot,
  StrategyDefinition,
  StrategyWorkspaceSnapshot
} from '../../shared/contracts'

// 两个面板只负责渲染，状态与 IPC 调用全部留在 App。
// 这样面板可以脱离真实 Electron 环境单独审查，也让 App 的
// 状态编排部分不再夹在几百行 JSX 里。

export interface ProjectRuntimeSummary {
  projectId: string
  status: string
}

export interface ProjectPanelProps {
  workspace: ProjectWorkspaceSnapshot | null
  activeProject: { id: string; name: string } | null
  anyRuntimeActive: boolean
  selectedRuntime: ProjectRuntimeSummary | null
  draftText: string
  onDraftChange: (value: string) => void
  onSelectProject: (projectId: string) => void
  onDeleteProject: (projectId: string) => void
  onInstallPlayground: () => void
  onNewProject: () => void
  onSaveProject: () => void
  onStartProject: (projectId: string) => void
  onPauseProject: (projectId: string) => void
  onResumeProject: (projectId: string) => void
  onStopProject: (projectId: string) => void
}

export function ProjectPanel(props: ProjectPanelProps): React.JSX.Element {
  const {
    workspace,
    activeProject,
    anyRuntimeActive,
    selectedRuntime,
    draftText
  } = props

  return (
    <section className="project-panel">
      <div className="panel-heading">
        <h2>Project</h2>
        <button
          type="button"
          disabled={anyRuntimeActive}
          onClick={props.onInstallPlayground}
        >
          安装自动化验收模板
        </button>
        <button type="button" onClick={props.onNewProject}>
          新建
        </button>
      </div>
      <p className="project-help">
        Project 固定 Profile、Strategy 版本、能力和 Workflow；
        运行时配置使用启动快照。
      </p>
      <div className="project-list">
        {workspace?.projects.length ? (
          workspace.projects.map((project) => {
            const runtime = [...(workspace.runtimes ?? [])]
              .reverse()
              .find((candidate) => candidate.projectId === project.id)
            return (
              <article
                className={`project-list-item ${
                  project.id === workspace.activeProjectId
                    ? 'project-list-item-active'
                    : ''
                }`}
                key={project.id}
              >
                <button
                  className="project-select"
                  type="button"
                  onClick={() => props.onSelectProject(project.id)}
                >
                  <strong>{project.name}</strong>
                  <small>
                    r{project.revision} · {runtime?.status ?? '未运行'}
                  </small>
                </button>
                <button
                  className="project-delete"
                  type="button"
                  disabled={anyRuntimeActive}
                  onClick={() => props.onDeleteProject(project.id)}
                >
                  删除
                </button>
              </article>
            )
          })
        ) : (
          <p className="event-empty">尚无 Project</p>
        )}
      </div>
      <div className="project-editor">
        <label>
          Project JSON
          <textarea
            aria-label="Project JSON"
            spellCheck={false}
            value={draftText}
            onChange={(event) => props.onDraftChange(event.target.value)}
          />
        </label>
        <div className="project-actions">
          <button
            type="button"
            disabled={anyRuntimeActive}
            onClick={props.onSaveProject}
          >
            保存
          </button>
          <button
            type="button"
            disabled={!activeProject || selectedRuntime !== null}
            onClick={() =>
              activeProject ? props.onStartProject(activeProject.id) : undefined
            }
          >
            启动
          </button>
          <button
            type="button"
            disabled={
              selectedRuntime === null || selectedRuntime.status === 'paused'
            }
            onClick={() =>
              activeProject ? props.onPauseProject(activeProject.id) : undefined
            }
          >
            {selectedRuntime?.status === 'queued' ? '暂停排队' : '暂停并接管'}
          </button>
          <button
            type="button"
            disabled={selectedRuntime?.status !== 'paused'}
            onClick={() =>
              activeProject
                ? props.onResumeProject(activeProject.id)
                : undefined
            }
          >
            恢复自动化
          </button>
          <button
            type="button"
            disabled={selectedRuntime === null}
            onClick={() =>
              activeProject ? props.onStopProject(activeProject.id) : undefined
            }
          >
            停止
          </button>
        </div>
        {workspace?.strategyResolutions.length ? (
          <ul className="project-resolution-list">
            {workspace.strategyResolutions.map((resolution) => (
              <li key={resolution.strategyId}>
                {resolution.strategyId}@{resolution.pinnedVersion}
                {' · '}
                {resolution.status}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  )
}

export interface StrategyPanelProps {
  workspace: StrategyWorkspaceSnapshot | null
  activeProjectStrategies: Array<{ id: string; version: string }>
  strategyEntries: Array<{ strategyId: string; status: string }>
  manifestText: string
  sourceText: string
  anyRuntimeActive: boolean
  onManifestChange: (value: string) => void
  onSourceChange: (value: string) => void
  onNewStrategy: () => void
  onEditStrategy: (definition: StrategyDefinition) => void
  onToggleEnabled: (strategyId: string, enabled: boolean) => void
  onDeleteStrategy: (strategyId: string) => void
  onSaveStrategy: () => void
}

export function StrategyPanel(props: StrategyPanelProps): React.JSX.Element {
  const { workspace, activeProjectStrategies, strategyEntries } = props

  return (
    <section className="strategy-panel">
      <div className="panel-heading">
        <h2>Strategy</h2>
        <button
          type="button"
          disabled={props.anyRuntimeActive}
          onClick={props.onNewStrategy}
        >
          新建
        </button>
      </div>
      <p className="strategy-help">
        启用控制注册表定义；运行时 allowlist 由 Project
        固定版本生成。项目运行期间定义不可修改。
      </p>
      <div className="strategy-list">
        {workspace?.strategies.length ? (
          workspace.strategies.map((definition) => {
            const projectPin = activeProjectStrategies.find(
              (pin) => pin.id === definition.manifest.id
            )
            const runtimeEntries = strategyEntries.filter(
              (entry) => entry.strategyId === definition.manifest.id
            )
            return (
              <article className="strategy-card" key={definition.manifest.id}>
                <button
                  className="strategy-edit"
                  type="button"
                  onClick={() => props.onEditStrategy(definition)}
                >
                  <strong>{definition.manifest.name}</strong>
                  <small>
                    {definition.manifest.id} · {definition.manifest.version}
                  </small>
                  <small>
                    {runtimeEntries.length === 0
                      ? '未运行'
                      : runtimeEntries.map((entry) => entry.status).join(', ')}
                  </small>
                  {projectPin ? (
                    <small>当前 Project 固定 {projectPin.version}</small>
                  ) : null}
                </button>
                <label>
                  <input
                    type="checkbox"
                    checked={definition.enabled}
                    disabled={props.anyRuntimeActive}
                    onChange={(event) =>
                      props.onToggleEnabled(
                        definition.manifest.id,
                        event.target.checked
                      )
                    }
                  />
                  启用
                </label>
                <button
                  className="strategy-delete"
                  type="button"
                  disabled={props.anyRuntimeActive}
                  onClick={() => props.onDeleteStrategy(definition.manifest.id)}
                >
                  删除
                </button>
              </article>
            )
          })
        ) : (
          <p className="event-empty">尚无 Strategy</p>
        )}
      </div>
      <div className="strategy-editor">
        <label>
          Manifest JSON
          <textarea
            aria-label="Strategy Manifest JSON"
            spellCheck={false}
            value={props.manifestText}
            onChange={(event) => props.onManifestChange(event.target.value)}
          />
        </label>
        <label>
          隔离 world 源码
          <textarea
            aria-label="Strategy 源码"
            spellCheck={false}
            value={props.sourceText}
            onChange={(event) => props.onSourceChange(event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={props.anyRuntimeActive}
          onClick={props.onSaveStrategy}
        >
          保存并重载页面
        </button>
      </div>
    </section>
  )
}
