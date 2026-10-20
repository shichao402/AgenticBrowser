import type {
  ProjectWorkspaceSnapshot,
  StrategyDefinition,
  StrategyWorkspaceSnapshot
} from '../../shared/contracts'

// 两个面板只负责渲染，状态与 IPC 调用全部留在 App。
// 设置页上线后，侧边栏不再承载任何配置文本域：编辑动作统一跳到
// 全屏设置页，侧边栏只保留运行期信息与入口（需求 9）。

export interface ProjectRuntimeSummary {
  projectId: string
  status: string
}

export interface ProjectPanelProps {
  workspace: ProjectWorkspaceSnapshot | null
  activeProject: { id: string; name: string } | null
  anyRuntimeActive: boolean
  selectedRuntime: ProjectRuntimeSummary | null
  onSelectProject: (projectId: string) => void
  onDeleteProject: (projectId: string) => void
  onInstallPlayground: () => void
  onNewProject: () => void
  onOpenSettings: () => void
  onStartProject: (projectId: string) => void
  onPauseProject: (projectId: string) => void
  onResumeProject: (projectId: string) => void
  onStopProject: (projectId: string) => void
}

export function ProjectPanel(props: ProjectPanelProps): React.JSX.Element {
  const { workspace, activeProject, anyRuntimeActive, selectedRuntime } = props

  return (
    <section className="project-panel">
      <div className="panel-heading">
        <h2>Project</h2>
        <button
          type="button"
          disabled={anyRuntimeActive}
          onClick={props.onInstallPlayground}
        >
          安装验收模板
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

      <div className="project-actions-panel">
        <button
          className="project-open-settings"
          type="button"
          onClick={props.onOpenSettings}
        >
          打开设置（表单配置）
        </button>
        <div className="project-actions">
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
  anyRuntimeActive: boolean
  onNewStrategy: () => void
  onEditStrategy: (definition: StrategyDefinition) => void
  onToggleEnabled: (strategyId: string, enabled: boolean) => void
  onDeleteStrategy: (strategyId: string) => void
  onOpenSettings: () => void
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

      <button
        className="strategy-open-settings"
        type="button"
        onClick={props.onOpenSettings}
      >
        打开设置（表单配置）
      </button>
    </section>
  )
}
