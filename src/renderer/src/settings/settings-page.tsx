import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  ProjectDraft,
  ProjectStrategyResolution,
  ProjectWorkspaceSnapshot,
  ProfileSummary,
  StrategyDefinition,
  StrategyManifest,
  StrategyWorkspaceSnapshot
} from '../../../shared/contracts'
import {
  createDefaultProjectDraft,
  createDefaultStrategyManifest,
  toProjectDraft
} from '../app-format'
import { JsonView, ViewModeSwitch } from './settings-json-view'
import type { ViewMode } from './settings-json-view'
import {
  ProjectBaseFields,
  ProjectOutputFields,
  ProjectRetryFields,
  ProjectRuntimeFields
} from './settings-project-basic'
import {
  ProjectCapabilityFields,
  ProjectFilterFields,
  ProjectStrategyPinsFields
} from './settings-project-policy'
import {
  StrategyManifestFields,
  StrategySourceFields
} from './settings-strategy'
import { ProjectWorkflowFields } from './settings-workflow'
import type { ProjectForm, StrategyForm } from './settings-model'
import {
  formToProject,
  formToStrategy,
  projectToForm,
  strategyToForm
} from './settings-model'
import type { ProjectSectionKey, ValidationIssue } from './settings-validation'
import {
  describeSaveError,
  fieldAnchorId,
  firstErrorPath,
  projectErrorSections,
  validateProjectForm,
  validateStrategyForm
} from './settings-validation'

export type SettingsTarget =
  | { kind: 'project'; projectId: string | null }
  | { kind: 'strategy'; strategyId: string | null }

export interface SettingsPageProps {
  target: SettingsTarget
  projectWorkspace: ProjectWorkspaceSnapshot | null
  strategyWorkspace: StrategyWorkspaceSnapshot | null
  profiles: ProfileSummary[]
  /** 任一 Project runtime 活动时禁止写入（需求 8.3）。 */
  anyRuntimeActive: boolean
  activeProfileId: string
  onClose: () => void
  onSavedProjects: (workspace: ProjectWorkspaceSnapshot) => void
  onSavedStrategies: (workspace: StrategyWorkspaceSnapshot) => void
  /** 保存 Strategy 后需要重载页面，沿用既有行为（需求 5.9）。 */
  onReloadPage: () => void
}

type ProjectTabKey = ProjectSectionKey
type StrategyTabKey = 'manifest' | 'source'

const PROJECT_TABS: Array<{ key: ProjectTabKey; label: string }> = [
  { key: 'base', label: '基础信息' },
  { key: 'runtime', label: '运行时' },
  { key: 'workflow', label: 'Workflow' },
  { key: 'output', label: '输出' },
  { key: 'capabilities', label: '能力策略' },
  { key: 'filter', label: '内容过滤' },
  { key: 'retry', label: '重试' },
  { key: 'strategies', label: '策略固定' }
]

const STRATEGY_TABS: Array<{ key: StrategyTabKey; label: string }> = [
  { key: 'manifest', label: 'Manifest' },
  { key: 'source', label: '源码' }
]

function strategyToManifestSource(definition: {
  manifest: StrategyManifest
  source: string
}): StrategyForm {
  return strategyToForm(definition.manifest, definition.source)
}

/**
 * 设置页外壳。
 *
 * 职责边界：表单状态、脏标记、校验与保存流程都在这里；各分区组件只负责
 * 渲染与回传 updater。这样新增配置项时不需要改动外壳。
 */
export function SettingsPage({
  target,
  projectWorkspace,
  strategyWorkspace,
  profiles,
  anyRuntimeActive,
  activeProfileId,
  onClose,
  onSavedProjects,
  onSavedStrategies,
  onReloadPage
}: SettingsPageProps): React.JSX.Element {
  const [kind, setKind] = useState(target.kind)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    target.kind === 'project' ? target.projectId : null
  )
  const [selectedStrategyId, setSelectedStrategyId] = useState<string | null>(
    target.kind === 'strategy' ? target.strategyId : null
  )

  const initialProjectDraft = useMemo<ProjectDraft>(() => {
    const workspace = projectWorkspace
    if (kind === 'project' && selectedProjectId) {
      const found = workspace?.projects.find(
        (project) => project.id === selectedProjectId
      )
      if (found) {
        return toProjectDraft(found)
      }
    }
    const profileId =
      profiles.find((profile) => profile.active)?.id ?? activeProfileId
    return createDefaultProjectDraft(profileId)
    // 仅在切换编辑对象时重建草稿，避免每次渲染覆盖用户输入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, selectedProjectId, projectWorkspace, activeProfileId])

  const [projectBaseline, setProjectBaseline] =
    useState<ProjectDraft>(initialProjectDraft)
  const [projectForm, setProjectForm] = useState<ProjectForm>(() =>
    projectToForm(initialProjectDraft)
  )

  const initialStrategy = useMemo<{
    manifest: StrategyManifest
    source: string
  }>(() => {
    if (kind === 'strategy' && selectedStrategyId) {
      const found = strategyWorkspace?.strategies.find(
        (definition) => definition.manifest.id === selectedStrategyId
      )
      if (found) {
        return { manifest: found.manifest, source: found.source }
      }
    }
    return {
      manifest: createDefaultStrategyManifest(),
      source: 'agenticStrategy.log("strategy ready")'
    }
  }, [kind, selectedStrategyId, strategyWorkspace])

  const [strategyBaseline, setStrategyBaseline] = useState(initialStrategy)
  const [strategyForm, setStrategyForm] = useState<StrategyForm>(() =>
    strategyToManifestSource(initialStrategy)
  )

  const [projectTab, setProjectTab] = useState<ProjectTabKey>('base')
  const [strategyTab, setStrategyTab] = useState<StrategyTabKey>('manifest')
  const [viewMode, setViewMode] = useState<ViewMode>('form')
  const [dirty, setDirty] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [issues, setIssues] = useState<ValidationIssue[]>([])
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [blockedMessage, setBlockedMessage] = useState<string | null>(null)
  const [narrowNavOpen, setNarrowNavOpen] = useState(false)

  const resolutions: ProjectStrategyResolution[] =
    projectWorkspace?.strategyResolutions ?? []

  const projectItems = projectWorkspace?.projects ?? []
  const strategyItems = strategyWorkspace?.strategies ?? []

  const changeProjectForm = useCallback(
    (updater: (current: ProjectForm) => ProjectForm): void => {
      setProjectForm((current) => updater(current))
      setDirty(true)
      setStatusMessage(null)
    },
    []
  )

  const changeStrategyForm = useCallback(
    (updater: (current: StrategyForm) => StrategyForm): void => {
      setStrategyForm((current) => updater(current))
      setDirty(true)
      setStatusMessage(null)
    },
    []
  )

  const resetProject = useCallback((draft: ProjectDraft): void => {
    setProjectBaseline(draft)
    setProjectForm(projectToForm(draft))
    setErrors({})
    setIssues([])
    setDirty(false)
    setStatusMessage(null)
    setBlockedMessage(null)
  }, [])

  const resetStrategy = useCallback(
    (source: { manifest: StrategyManifest; source: string }): void => {
      setStrategyBaseline(source)
      setStrategyForm(strategyToManifestSource(source))
      setErrors({})
      setIssues([])
      setDirty(false)
      setStatusMessage(null)
    },
    []
  )

  const confirmDiscard = (action: string): boolean => {
    if (!dirty) {
      return true
    }
    return window.confirm(`存在未保存的修改，${action}将丢失这些修改。继续？`)
  }

  const requestClose = (): void => {
    if (!confirmDiscard('返回工作台')) {
      return
    }
    onClose()
  }

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return
      }
      const tag = (event.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        return
      }
      requestClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // requestClose 依赖 dirty，dirty 变化时重新绑定即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty])

  const switchKind = (next: 'project' | 'strategy'): void => {
    if (next === kind) {
      return
    }
    if (!confirmDiscard('切换分区')) {
      return
    }
    setKind(next)
    setViewMode('form')
    setErrors({})
    setIssues([])
    setStatusMessage(null)
    setBlockedMessage(null)
    if (next === 'project') {
      const project =
        projectWorkspace?.projects.find(
          (item) => item.id === selectedProjectId
        ) ??
        (projectWorkspace?.activeProjectId
          ? projectWorkspace.projects.find(
              (item) => item.id === projectWorkspace.activeProjectId
            )
          : undefined)
      if (project) {
        setSelectedProjectId(project.id)
        resetProject(toProjectDraft(project))
      } else {
        setSelectedProjectId(null)
        resetProject(
          createDefaultProjectDraft(
            profiles.find((profile) => profile.active)?.id ?? activeProfileId
          )
        )
      }
    } else if (strategyItems.length > 0) {
      const strategy = strategyItems[0]
      if (strategy) {
        setSelectedStrategyId(strategy.manifest.id)
        resetStrategy({
          manifest: strategy.manifest,
          source: strategy.source
        })
      }
    } else {
      setSelectedStrategyId(null)
      resetStrategy({
        manifest: createDefaultStrategyManifest(),
        source: 'agenticStrategy.log("strategy ready")'
      })
    }
  }

  const selectProject = (projectId: string | null): void => {
    if (!confirmDiscard('切换 Project')) {
      return
    }
    if (projectId === null) {
      setSelectedProjectId(null)
      setProjectTab('base')
      resetProject(
        createDefaultProjectDraft(
          profiles.find((profile) => profile.active)?.id ?? activeProfileId
        )
      )
      return
    }
    const project = projectWorkspace?.projects.find(
      (item) => item.id === projectId
    )
    if (!project) {
      return
    }
    setSelectedProjectId(project.id)
    setProjectTab('base')
    resetProject(toProjectDraft(project))
  }

  const selectStrategy = (strategyId: string | null): void => {
    if (!confirmDiscard('切换 Strategy')) {
      return
    }
    if (strategyId === null) {
      setSelectedStrategyId(null)
      setStrategyTab('manifest')
      resetStrategy({
        manifest: createDefaultStrategyManifest(),
        source: 'agenticStrategy.log("strategy ready")'
      })
      return
    }
    const definition: StrategyDefinition | undefined =
      strategyWorkspace?.strategies.find(
        (item) => item.manifest.id === strategyId
      )
    if (!definition) {
      return
    }
    setSelectedStrategyId(definition.manifest.id)
    setStrategyTab('manifest')
    resetStrategy({ manifest: definition.manifest, source: definition.source })
  }

  const isNewProject =
    selectedProjectId === null ||
    !projectItems.some((project) => project.id === selectedProjectId)
  const isNewStrategy =
    selectedStrategyId === null ||
    !strategyItems.some(
      (definition) => definition.manifest.id === selectedStrategyId
    )

  const locked = anyRuntimeActive

  const focusFirstError = (validationIssues: ValidationIssue[]): void => {
    const path = firstErrorPath({ errors: {}, issues: validationIssues })
    if (!path) {
      return
    }
    const element = document.getElementById(fieldAnchorId(path))
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' })
      const focusable = element.querySelector<HTMLElement>(
        'input, select, textarea, button'
      )
      focusable?.focus()
    }
  }

  const saveProject = async (): Promise<void> => {
    if (locked) {
      setStatusMessage('任一 Project 运行中，暂不可保存配置。')
      return
    }
    const validation = validateProjectForm(projectForm)
    setErrors(validation.errors)
    setIssues(validation.issues)
    if (validation.issues.length > 0) {
      const sections = projectErrorSections(validation)
      const firstSection = PROJECT_TABS.find((tab) => sections.has(tab.key))
      if (firstSection) {
        setProjectTab(firstSection.key)
      }
      setStatusMessage(`校验未通过：${validation.issues.length} 个问题待修正`)
      focusFirstError(validation.issues)
      return
    }

    const draft = formToProject(projectForm, projectBaseline)
    try {
      const workspace = await window.agenticBrowser.saveProject(draft)
      onSavedProjects(workspace)
      const saved = workspace.projects.find(
        (project) => project.id === draft.id
      )
      if (saved) {
        setSelectedProjectId(saved.id)
        resetProject(toProjectDraft(saved))
      } else {
        resetProject(draft)
      }
      setStatusMessage(`已保存 Project ${draft.id}`)
    } catch (cause) {
      const inline = describeSaveError(cause, { kind: 'project', id: draft.id })
      setIssues(inline)
      setErrors({ save: inline[0]?.message ?? '保存失败' })
      setStatusMessage(null)
    }
  }

  const saveStrategy = async (): Promise<void> => {
    if (locked) {
      setStatusMessage('任一 Project 运行中，暂不可保存配置。')
      return
    }
    const validation = validateStrategyForm(strategyForm)
    setErrors(validation.errors)
    setIssues(validation.issues)
    if (validation.issues.length > 0) {
      setStatusMessage(`校验未通过：${validation.issues.length} 个问题待修正`)
      focusFirstError(validation.issues)
      return
    }

    const manifest = formToStrategy(strategyForm, strategyBaseline.manifest)
    const existing = strategyWorkspace?.strategies.find(
      (definition) => definition.manifest.id === selectedStrategyId
    )
    try {
      const workspace = await window.agenticBrowser.saveStrategy({
        manifest,
        source: strategyForm.source,
        enabled: existing?.enabled ?? true
      })
      onSavedStrategies(workspace)
      setSelectedStrategyId(manifest.id)
      resetStrategy({ manifest, source: strategyForm.source })
      setStatusMessage(`已保存 Strategy ${manifest.id}，页面将重载以注入新版本`)
      onReloadPage()
    } catch (cause) {
      const inline = describeSaveError(cause, {
        kind: 'strategy',
        id: manifest.id
      })
      setIssues(inline)
      setErrors({ save: inline[0]?.message ?? '保存失败' })
      setStatusMessage(null)
    }
  }

  const deleteCurrentProject = async (): Promise<void> => {
    if (locked || !selectedProjectId) {
      return
    }
    if (!window.confirm(`确认删除 Project ${selectedProjectId}？`)) {
      return
    }
    try {
      const workspace =
        await window.agenticBrowser.deleteProject(selectedProjectId)
      onSavedProjects(workspace)
      setSelectedProjectId(null)
      resetProject(
        createDefaultProjectDraft(
          profiles.find((profile) => profile.active)?.id ?? activeProfileId
        )
      )
      setStatusMessage('已删除 Project')
    } catch (cause) {
      const inline = describeSaveError(cause, {
        kind: 'project',
        id: selectedProjectId
      })
      setErrors({ save: inline[0]?.message ?? '删除失败' })
    }
  }

  const deleteCurrentStrategy = async (): Promise<void> => {
    if (locked || !selectedStrategyId) {
      return
    }
    if (!window.confirm(`确认删除 Strategy ${selectedStrategyId}？`)) {
      return
    }
    try {
      const workspace =
        await window.agenticBrowser.deleteStrategy(selectedStrategyId)
      onSavedStrategies(workspace)
      setSelectedStrategyId(null)
      resetStrategy({
        manifest: createDefaultStrategyManifest(),
        source: 'agenticStrategy.log("strategy ready")'
      })
      setStatusMessage('已删除 Strategy')
    } catch (cause) {
      const inline = describeSaveError(cause, {
        kind: 'strategy',
        id: selectedStrategyId
      })
      setErrors({ save: inline[0]?.message ?? '删除失败' })
    }
  }

  const errorSections = projectErrorSections({ errors, issues })
  const jsonValue =
    kind === 'project'
      ? formToProject(projectForm, projectBaseline)
      : formToStrategy(strategyForm, strategyBaseline.manifest)

  const applyJsonToForm = (
    parsed: unknown
  ): { ok: true } | { ok: false; message: string } => {
    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, message: '顶层必须是 JSON 对象' }
    }
    if (kind === 'project') {
      const draft = parsed as ProjectDraft
      const knownKeys = new Set([
        'id',
        'name',
        'profileId',
        'startupPages',
        'strategies',
        'runtime',
        'workflow',
        'output',
        'capabilities',
        'filter',
        'retry',
        'enabled'
      ])
      const unknown = Object.keys(draft).filter((key) => !knownKeys.has(key))
      if (unknown.length > 0) {
        return {
          ok: false,
          message: `以下字段无法映射到表单：${unknown.join('、')}。请在校验通过后移除它们。`
        }
      }
      setProjectForm(projectToForm(draft))
      setDirty(true)
      return { ok: true }
    }

    const manifest = parsed as StrategyManifest
    const knownKeys = new Set([
      'id',
      'name',
      'version',
      'matches',
      'excludes',
      'runAt',
      'frames',
      'permissions',
      'networkMatches',
      'config',
      'timeouts'
    ])
    const unknown = Object.keys(manifest).filter((key) => !knownKeys.has(key))
    if (unknown.length > 0) {
      return {
        ok: false,
        message: `以下字段无法映射到表单：${unknown.join('、')}。`
      }
    }
    setStrategyForm((current) => ({
      ...strategyToForm(manifest, current.source)
    }))
    setDirty(true)
    return { ok: true }
  }

  const tabs = kind === 'project' ? PROJECT_TABS : STRATEGY_TABS
  const activeTabKey = kind === 'project' ? projectTab : strategyTab

  const headerTitle =
    kind === 'project'
      ? isNewProject
        ? '新建 Project'
        : `Project · ${projectForm.base.name || projectForm.base.id}`
      : isNewStrategy
        ? '新建 Strategy'
        : `Strategy · ${strategyForm.manifest.name || strategyForm.manifest.id}`

  return (
    <div className="settings-page">
      <header className="settings-header">
        <div className="settings-header-main">
          <button type="button" onClick={requestClose}>
            ← 返回工作台
          </button>
          <div>
            <h1>
              {headerTitle}
              {dirty ? (
                <span className="settings-dirty" title="存在未保存的修改">
                  未保存
                </span>
              ) : null}
            </h1>
            <p>
              {locked
                ? '有 Project 正在运行，当前为只读模式：可浏览但不可保存或删除。'
                : '所有字段均以表单配置，JSON 仅作为可选的高级视图。'}
            </p>
          </div>
        </div>
        <div className="settings-header-actions">
          <ViewModeSwitch
            mode={viewMode}
            onChange={setViewMode}
            disabled={false}
          />
          {kind === 'project' ? (
            <>
              <button
                type="button"
                disabled={locked || !selectedProjectId || isNewProject}
                onClick={() => void deleteCurrentProject()}
              >
                删除
              </button>
              <button
                type="button"
                disabled={locked}
                onClick={() => void saveProject()}
              >
                保存 Project
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                disabled={locked || isNewStrategy}
                onClick={() => void deleteCurrentStrategy()}
              >
                删除
              </button>
              <button
                type="button"
                disabled={locked}
                onClick={() => void saveStrategy()}
              >
                保存并重载页面
              </button>
            </>
          )}
        </div>
      </header>

      {locked ? (
        <p className="settings-lock-banner" role="status">
          运行态锁定中：停止全部 Project
          运行后即可编辑。已输入的内容不会被清除。
        </p>
      ) : null}
      {statusMessage ? (
        <p className="settings-status-banner" role="status">
          {statusMessage}
        </p>
      ) : null}
      {errors.save ? (
        <p className="settings-error-banner" role="alert">
          {errors.save}
        </p>
      ) : null}

      <div className="settings-body">
        <nav className="settings-nav" aria-label="设置分区">
          <div className="settings-kind-switch" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={kind === 'project'}
              className={kind === 'project' ? 'is-active' : ''}
              onClick={() => switchKind('project')}
            >
              Project
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={kind === 'strategy'}
              className={kind === 'strategy' ? 'is-active' : ''}
              onClick={() => switchKind('strategy')}
            >
              Strategy
            </button>
          </div>

          <label className="settings-object-select">
            <span>{kind === 'project' ? '编辑对象' : '编辑对象'}</span>
            <select
              value={
                kind === 'project'
                  ? (selectedProjectId ?? '')
                  : (selectedStrategyId ?? '')
              }
              onChange={(event) => {
                const value = event.target.value
                if (kind === 'project') {
                  selectProject(value.length > 0 ? value : null)
                } else {
                  selectStrategy(value.length > 0 ? value : null)
                }
              }}
            >
              <option value="">
                {kind === 'project' ? '＋ 新建 Project' : '＋ 新建 Strategy'}
              </option>
              {kind === 'project'
                ? projectItems.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))
                : strategyItems.map((definition) => (
                    <option
                      key={definition.manifest.id}
                      value={definition.manifest.id}
                    >
                      {definition.manifest.name}
                    </option>
                  ))}
            </select>
          </label>

          {kind === 'project' && projectForm.base.id !== '' ? (
            <p className="settings-nav-meta">
              当前生效 ID：<code>{projectForm.base.id}</code>
              {isNewProject ? '（尚未保存）' : ''}
            </p>
          ) : null}
          {kind === 'strategy' && strategyForm.manifest.id !== '' ? (
            <p className="settings-nav-meta">
              当前生效 ID：<code>{strategyForm.manifest.id}</code>
              {isNewStrategy ? '（尚未保存）' : ''}
            </p>
          ) : null}

          <button
            className="settings-nav-toggle"
            type="button"
            aria-expanded={narrowNavOpen}
            onClick={() => setNarrowNavOpen((open) => !open)}
          >
            分区导航（{tabs.length}）{narrowNavOpen ? '▴' : '▾'}
          </button>
          <ul className={`settings-nav-list ${narrowNavOpen ? 'is-open' : ''}`}>
            {tabs.map((tab) => {
              const hasError =
                kind === 'project' &&
                errorSections.has(tab.key as ProjectSectionKey)
              return (
                <li key={tab.key}>
                  <button
                    type="button"
                    className={`${activeTabKey === tab.key ? 'is-active' : ''} ${
                      hasError ? 'has-error' : ''
                    }`}
                    onClick={() => {
                      if (kind === 'project') {
                        setProjectTab(tab.key as ProjectSectionKey)
                      } else {
                        setStrategyTab(tab.key as StrategyTabKey)
                      }
                      setNarrowNavOpen(false)
                    }}
                  >
                    {tab.label}
                    {hasError ? <span className="settings-nav-dot" /> : null}
                  </button>
                </li>
              )
            })}
          </ul>

          {issues.length > 0 ? (
            <div className="settings-issue-summary">
              <h3>问题摘要（{issues.length}）</h3>
              <ul>
                {issues.slice(0, 12).map((issue, index) => (
                  <li key={`${issue.path}-${index}`}>
                    <button
                      type="button"
                      onClick={() => focusFirstError([issue])}
                    >
                      {issue.message}
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" onClick={() => focusFirstError(issues)}>
                跳到首个问题
              </button>
            </div>
          ) : null}
        </nav>

        <div className="settings-content">
          {viewMode === 'json' ? (
            <JsonView
              value={jsonValue}
              disabled={locked}
              onApply={applyJsonToForm}
            />
          ) : kind === 'project' ? (
            <>
              {projectTab === 'base' ? (
                <ProjectBaseFields
                  form={projectForm}
                  errors={errors}
                  profiles={profiles}
                  locked={locked}
                  onChange={changeProjectForm}
                />
              ) : null}
              {projectTab === 'runtime' ? (
                <ProjectRuntimeFields
                  form={projectForm}
                  errors={errors}
                  profiles={profiles}
                  locked={locked}
                  onChange={changeProjectForm}
                />
              ) : null}
              {projectTab === 'workflow' ? (
                <ProjectWorkflowFields
                  form={projectForm}
                  errors={errors}
                  locked={locked}
                  blockedMessage={blockedMessage}
                  onChange={changeProjectForm}
                  onBlockedChange={setBlockedMessage}
                />
              ) : null}
              {projectTab === 'output' ? (
                <ProjectOutputFields
                  form={projectForm}
                  errors={errors}
                  profiles={profiles}
                  locked={locked}
                  onChange={changeProjectForm}
                />
              ) : null}
              {projectTab === 'capabilities' ? (
                <ProjectCapabilityFields
                  form={projectForm}
                  errors={errors}
                  locked={locked}
                  onChange={changeProjectForm}
                />
              ) : null}
              {projectTab === 'filter' ? (
                <ProjectFilterFields
                  form={projectForm}
                  errors={errors}
                  locked={locked}
                  onChange={changeProjectForm}
                />
              ) : null}
              {projectTab === 'retry' ? (
                <ProjectRetryFields
                  form={projectForm}
                  errors={errors}
                  profiles={profiles}
                  locked={locked}
                  onChange={changeProjectForm}
                />
              ) : null}
              {projectTab === 'strategies' ? (
                <ProjectStrategyPinsFields
                  form={projectForm}
                  errors={errors}
                  locked={locked}
                  registry={strategyWorkspace}
                  resolutions={resolutions}
                  onChange={changeProjectForm}
                />
              ) : null}
            </>
          ) : (
            <>
              {strategyTab === 'manifest' ? (
                <StrategyManifestFields
                  form={strategyForm}
                  errors={errors}
                  locked={locked}
                  onChange={changeStrategyForm}
                />
              ) : null}
              {strategyTab === 'source' ? (
                <StrategySourceFields
                  form={strategyForm}
                  errors={errors}
                  locked={locked}
                  onChange={changeStrategyForm}
                />
              ) : null}
            </>
          )}

          <footer className="settings-footnote">
            <p className="settings-hint">
              默认使用表单视图；切换到 JSON 可查看当前表单的序列化结果，
              但保存仍走同一套字段校验与既有 IPC 通道。
            </p>
          </footer>
        </div>
      </div>
    </div>
  )
}
