import {
  Field,
  FormSection,
  RowActions,
  SelectInput,
  Switch,
  TextInput
} from './settings-fields'
import type { ProjectForm, WorkflowNodeForm } from './settings-model'
import {
  WORKFLOW_FAILURE_CATEGORIES,
  WORKFLOW_FAILURE_LABELS,
  WORKFLOW_NODE_KINDS,
  createWorkflowNodeForm,
  findNodeReferences,
  renameWorkflowNode,
  switchWorkflowNodeKind
} from './settings-model'

export interface ProjectWorkflowFieldsProps {
  form: ProjectForm
  errors: Record<string, string>
  locked: boolean
  /** 被引用节点删除被阻止时展示的原因。 */
  blockedMessage: string | null
  onChange: (updater: (current: ProjectForm) => ProjectForm) => void
  onBlockedChange: (message: string | null) => void
}

function errorOf(
  errors: Record<string, string>,
  path: string
): string | undefined {
  return errors[path]
}

export function ProjectWorkflowFields({
  form,
  errors,
  locked,
  blockedMessage,
  onChange,
  onBlockedChange
}: ProjectWorkflowFieldsProps): React.JSX.Element {
  const nodes = form.workflow.nodes
  const nodeIdOptions = nodes
    .filter((node) => node.id.trim().length > 0)
    .map((node) => ({ value: node.id, label: node.id }))

  const updateWorkflow = (
    updater: (current: ProjectForm['workflow']) => ProjectForm['workflow']
  ): void => {
    onChange((current) => ({
      ...current,
      workflow: updater(current.workflow)
    }))
  }

  const updateNode = (
    index: number,
    patch: Partial<WorkflowNodeForm>
  ): void => {
    updateWorkflow((workflow) => ({
      ...workflow,
      nodes: workflow.nodes.map((node, current) =>
        current === index ? { ...node, ...patch } : node
      )
    }))
  }

  const moveNode = (index: number, delta: number): void => {
    updateWorkflow((workflow) => {
      const target = index + delta
      if (target < 0 || target >= workflow.nodes.length) {
        return workflow
      }
      const next = [...workflow.nodes]
      const [moved] = next.splice(index, 1)
      if (!moved) {
        return workflow
      }
      next.splice(target, 0, moved)
      return { ...workflow, nodes: next }
    })
  }

  const removeNode = (index: number): void => {
    const node = nodes[index]
    if (!node) {
      return
    }
    const references = findNodeReferences(form.workflow, node.id)
    if (references.length > 0) {
      onBlockedChange(
        `节点 ${node.id} 仍被引用，无法删除：${references.join('、')}`
      )
      return
    }
    onBlockedChange(null)
    updateWorkflow((workflow) => ({
      ...workflow,
      nodes: workflow.nodes.filter((_, current) => current !== index),
      entryNodeId: workflow.entryNodeId === node.id ? '' : workflow.entryNodeId
    }))
  }

  const addNode = (kind: WorkflowNodeForm['kind']): void => {
    onBlockedChange(null)
    updateWorkflow((workflow) => {
      const created = createWorkflowNodeForm(
        kind,
        workflow.nodes.map((node) => node.id)
      )
      const nodes = [...workflow.nodes, created]
      return {
        ...workflow,
        nodes,
        entryNodeId: workflow.entryNodeId || created.id
      }
    })
  }

  return (
    <FormSection
      title="Workflow"
      description="运行由节点串联而成：入口节点开始，按 next 逐跳推进，遇到 complete 结束。"
      actions={
        <div className="settings-inline-actions">
          {WORKFLOW_NODE_KINDS.map((kind) => (
            <button
              key={kind.value}
              type="button"
              disabled={locked}
              title={kind.hint}
              onClick={() => addNode(kind.value)}
            >
              + {kind.label}
            </button>
          ))}
        </div>
      }
    >
      {blockedMessage ? (
        <p className="settings-error settings-blocked" role="alert">
          {blockedMessage}
        </p>
      ) : null}

      <div className="settings-grid settings-grid-3">
        <Field
          label="定义版本"
          path="workflow.version"
          hint="变更 Workflow 结构时递增，运行记录会带上此版本"
          error={errorOf(errors, 'workflow.version')}
        >
          <input
            id="field-workflow-version"
            type="number"
            min={1}
            step={1}
            value={form.workflow.versionText}
            disabled={locked}
            onChange={(event) =>
              updateWorkflow((workflow) => ({
                ...workflow,
                versionText: event.target.value
              }))
            }
          />
        </Field>

        <Field
          label="入口节点"
          path="workflow.entryNodeId"
          hint="运行从这里开始"
          error={errorOf(errors, 'workflow.entryNodeId')}
        >
          <SelectInput
            id="field-workflow-entryNodeId"
            value={form.workflow.entryNodeId}
            options={nodeIdOptions}
            disabled={locked}
            allowEmpty="请选择入口节点"
            onChange={(value) =>
              updateWorkflow((workflow) => ({
                ...workflow,
                entryNodeId: value
              }))
            }
          />
        </Field>

        <Field
          label="节点数量"
          path="workflow.nodes"
          hint="至少一个节点，且不能存在悬空引用"
          error={errorOf(errors, 'workflow.nodes')}
        >
          <p className="settings-readonly-value">{nodes.length} 个节点</p>
        </Field>
      </div>

      {nodes.length === 0 ? (
        <p className="settings-empty">尚无节点，请从右上角新增一个节点。</p>
      ) : null}

      <ol className="settings-node-list">
        {nodes.map((node, index) => {
          const kindMeta = WORKFLOW_NODE_KINDS.find(
            (kind) => kind.value === node.kind
          )
          const isEntry = form.workflow.entryNodeId === node.id
          return (
            <li className="settings-node-card" key={`node-${index}`}>
              <header className="settings-node-head">
                <div>
                  <strong>{node.id || `节点 ${index + 1}`}</strong>
                  <span className="settings-badge">{kindMeta?.label}</span>
                  {isEntry ? (
                    <span className="settings-badge settings-badge-accent">
                      入口
                    </span>
                  ) : null}
                </div>
                <RowActions
                  canMoveUp={index > 0}
                  canMoveDown={index < nodes.length - 1}
                  onMoveUp={() => moveNode(index, -1)}
                  onMoveDown={() => moveNode(index, 1)}
                  onRemove={() => removeNode(index)}
                  removeDisabled={locked}
                />
              </header>

              <div className="settings-grid settings-grid-3">
                <Field
                  label="节点 ID"
                  path={`workflow.nodes.${index}.id`}
                  hint="修改后会自动同步所有引用"
                  error={errorOf(errors, `workflow.nodes.${index}.id`)}
                >
                  <input
                    id={`field-workflow-nodes-${index}-id`}
                    type="text"
                    spellCheck={false}
                    value={node.id}
                    disabled={locked}
                    onChange={(event) =>
                      updateWorkflow((workflow) =>
                        renameWorkflowNode(
                          workflow,
                          node.id,
                          event.target.value
                        )
                      )
                    }
                  />
                </Field>

                <Field
                  label="节点类型"
                  path={`workflow.nodes.${index}.kind`}
                  hint={kindMeta?.hint}
                  error={errorOf(errors, `workflow.nodes.${index}.kind`)}
                >
                  <SelectInput
                    id={`field-workflow-nodes-${index}-kind`}
                    value={node.kind}
                    options={WORKFLOW_NODE_KINDS.map((kind) => ({
                      value: kind.value,
                      label: kind.label
                    }))}
                    disabled={locked}
                    onChange={(value) =>
                      updateNode(index, switchWorkflowNodeKind(node, value))
                    }
                  />
                </Field>

                {node.kind !== 'complete' ? (
                  <Field
                    label="下一节点"
                    path={`workflow.nodes.${index}.next`}
                    error={errorOf(errors, `workflow.nodes.${index}.next`)}
                  >
                    <SelectInput
                      id={`field-workflow-nodes-${index}-next`}
                      value={node.next}
                      options={nodeIdOptions.filter(
                        (option) => option.value !== node.id
                      )}
                      disabled={locked}
                      allowEmpty="请选择下一节点"
                      onChange={(value) => updateNode(index, { next: value })}
                    />
                  </Field>
                ) : (
                  <Field
                    label="下一节点"
                    path={`workflow.nodes.${index}.next`}
                    hint="complete 节点结束本次运行，无下一跳"
                  >
                    <p className="settings-readonly-value">—</p>
                  </Field>
                )}
              </div>

              {node.kind === 'navigate' ? (
                <Field
                  label="目标 URL"
                  path={`workflow.nodes.${index}.url`}
                  hint="支持 http/https；导航完成后进入下一节点"
                  error={errorOf(errors, `workflow.nodes.${index}.url`)}
                >
                  <TextInput
                    id={`field-workflow-nodes-${index}-url`}
                    value={node.url}
                    disabled={locked}
                    monospace
                    onChange={(value) => updateNode(index, { url: value })}
                  />
                </Field>
              ) : null}

              {node.kind === 'wait-for-event' ? (
                <Field
                  label="事件名"
                  path={`workflow.nodes.${index}.eventName`}
                  hint="等待项目事件名，例如 project.complete；由 Strategy 通过 project.emit-event 发出"
                  error={errorOf(errors, `workflow.nodes.${index}.eventName`)}
                >
                  <TextInput
                    id={`field-workflow-nodes-${index}-eventName`}
                    value={node.eventName}
                    disabled={locked}
                    monospace
                    onChange={(value) =>
                      updateNode(index, { eventName: value })
                    }
                  />
                </Field>
              ) : null}

              {node.kind === 'delay' ? (
                <Field
                  label="延时时长（毫秒）"
                  path={`workflow.nodes.${index}.delayMs`}
                  hint="1000 = 1 秒"
                  error={errorOf(errors, `workflow.nodes.${index}.delayMs`)}
                >
                  <input
                    id={`field-workflow-nodes-${index}-delayMs`}
                    type="number"
                    min={0}
                    step={100}
                    value={node.delayMsText}
                    disabled={locked}
                    onChange={(event) =>
                      updateNode(index, { delayMsText: event.target.value })
                    }
                  />
                </Field>
              ) : null}

              <details className="settings-advanced">
                <summary>高级：超时、重试、检查点与失败处理</summary>
                <div className="settings-grid settings-grid-3">
                  <Field
                    label="单节点超时（毫秒）"
                    path={`workflow.nodes.${index}.timeoutMs`}
                    error={errorOf(errors, `workflow.nodes.${index}.timeoutMs`)}
                  >
                    <input
                      id={`field-workflow-nodes-${index}-timeoutMs`}
                      type="number"
                      min={1}
                      step={1000}
                      value={node.timeoutMsText}
                      disabled={locked}
                      onChange={(event) =>
                        updateNode(index, {
                          timeoutMsText: event.target.value
                        })
                      }
                    />
                  </Field>

                  <Field
                    label="最大尝试次数"
                    path={`workflow.nodes.${index}.maxAttempts`}
                    error={errorOf(
                      errors,
                      `workflow.nodes.${index}.maxAttempts`
                    )}
                  >
                    <input
                      id={`field-workflow-nodes-${index}-maxAttempts`}
                      type="number"
                      min={1}
                      step={1}
                      value={node.maxAttemptsText}
                      disabled={locked}
                      onChange={(event) =>
                        updateNode(index, {
                          maxAttemptsText: event.target.value
                        })
                      }
                    />
                  </Field>

                  <Field
                    label="幂等键"
                    path={`workflow.nodes.${index}.idempotencyKey`}
                    hint="用于去重下载等副作用，可留空"
                    error={errorOf(
                      errors,
                      `workflow.nodes.${index}.idempotencyKey`
                    )}
                  >
                    <TextInput
                      id={`field-workflow-nodes-${index}-idempotencyKey`}
                      value={node.idempotencyKey}
                      disabled={locked}
                      monospace
                      onChange={(value) =>
                        updateNode(index, { idempotencyKey: value })
                      }
                    />
                  </Field>
                </div>

                <Field
                  label="保存检查点"
                  path={`workflow.nodes.${index}.checkpoint`}
                >
                  <Switch
                    id={`field-workflow-nodes-${index}-checkpoint`}
                    label={node.checkpoint ? '已开启' : '已关闭'}
                    checked={node.checkpoint}
                    disabled={locked}
                    onChange={(checked) =>
                      updateNode(index, { checkpoint: checked })
                    }
                  />
                </Field>

                <fieldset className="settings-failure-map">
                  <legend>失败处理：失败类别 → 目标节点</legend>
                  <p className="settings-hint">
                    留空表示按默认失败策略处理（重试后判定 Project 失败）。
                  </p>
                  <div className="settings-failure-grid">
                    {WORKFLOW_FAILURE_CATEGORIES.map((category) => (
                      <label key={category}>
                        <span>{WORKFLOW_FAILURE_LABELS[category]}</span>
                        <select
                          value={node.onFailure[category] ?? ''}
                          disabled={locked}
                          onChange={(event) => {
                            const value = event.target.value
                            const onFailure = { ...node.onFailure }
                            if (value.length === 0) {
                              delete onFailure[category]
                            } else {
                              onFailure[category] = value
                            }
                            updateNode(index, { onFailure })
                          }}
                        >
                          <option value="">默认</option>
                          {nodeIdOptions
                            .filter((option) => option.value !== node.id)
                            .map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                        </select>
                      </label>
                    ))}
                  </div>
                </fieldset>
              </details>
            </li>
          )
        })}
      </ol>
    </FormSection>
  )
}
