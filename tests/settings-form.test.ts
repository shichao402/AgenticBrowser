import { describe, expect, it } from 'vitest'

import {
  createDefaultProjectDraft,
  createDefaultStrategyManifest
} from '../src/renderer/src/app-format'
import {
  bytesToMibText,
  createWorkflowNodeForm,
  findDanglingNodeReferences,
  findNodeReferences,
  formToProject,
  formToStrategy,
  isExactOrigin,
  minutesTextToMs,
  msToMinutesText,
  parseStrategyConfig,
  projectToForm,
  renameWorkflowNode,
  strategyToForm,
  switchWorkflowNodeKind,
  workflowNodeFormToNode,
  workflowNodeToForm
} from '../src/renderer/src/settings/settings-model'
import {
  checkStrategySourceSyntax,
  fieldAnchorId,
  projectErrorSections,
  validateProjectForm,
  validateStrategyForm
} from '../src/renderer/src/settings/settings-validation'

function defaultDraft() {
  return createDefaultProjectDraft('profile-default')
}

describe('settings-model: 草稿往返', () => {
  it('默认草稿经表单往返后保持等价', () => {
    const draft = defaultDraft()
    const roundTripped = formToProject(projectToForm(draft), draft)
    expect(roundTripped).toEqual(draft)
  })

  it('schedule 模式在往返中保留调度配置', () => {
    const draft: ReturnType<typeof defaultDraft> = {
      ...defaultDraft(),
      runtime: {
        ...defaultDraft().runtime,
        mode: 'schedule',
        schedule: { kind: 'daily', times: ['08:30', '20:15'] }
      }
    }
    const roundTripped = formToProject(projectToForm(draft), draft)
    expect(roundTripped.runtime.schedule).toEqual({
      kind: 'daily',
      times: ['08:30', '20:15']
    })
  })

  it('切回非 schedule 模式时从提交载荷中移除 schedule', () => {
    const draft: ReturnType<typeof defaultDraft> = {
      ...defaultDraft(),
      runtime: {
        ...defaultDraft().runtime,
        mode: 'schedule',
        schedule: { kind: 'interval', everyMinutes: 15 }
      }
    }
    const form = projectToForm(draft)
    const manualForm = {
      ...form,
      runtime: { ...form.runtime, mode: 'manual' as const }
    }
    const payload = formToProject(manualForm, draft)
    expect(payload.runtime.schedule).toBeUndefined()
    expect('schedule' in payload.runtime).toBe(false)
  })

  it('interval 调度在往返中保留分钟数', () => {
    const draft: ReturnType<typeof defaultDraft> = {
      ...defaultDraft(),
      runtime: {
        ...defaultDraft().runtime,
        mode: 'schedule',
        schedule: { kind: 'interval', everyMinutes: 45 }
      }
    }
    const payload = formToProject(projectToForm(draft), draft)
    expect(payload.runtime.schedule).toEqual({
      kind: 'interval',
      everyMinutes: 45
    })
  })

  it('毫秒与分钟、字节与 MiB 的换算可逆', () => {
    expect(msToMinutesText(3_600_000)).toBe('60')
    expect(minutesTextToMs('60', 0)).toBe(3_600_000)
    expect(bytesToMibText(10 * 1024 * 1024 * 1024)).toBe('10240')
  })

  it('精确 Origin 校验拒绝路径与通配符', () => {
    expect(isExactOrigin('https://example.com')).toBe(true)
    expect(isExactOrigin('https://example.com:8443')).toBe(true)
    expect(isExactOrigin('https://example.com/path')).toBe(false)
    expect(isExactOrigin('https://*.example.com')).toBe(false)
    expect(isExactOrigin('example.com')).toBe(false)
    expect(isExactOrigin('ftp://example.com')).toBe(false)
  })
})

describe('settings-model: 节点类型切换与引用', () => {
  it('切换节点类型保留公共字段与已输入专属字段', () => {
    const node = createWorkflowNodeForm('navigate', ['open-home'])
    const withValues = {
      ...node,
      url: 'https://example.com/feed',
      timeoutMsText: '45000',
      maxAttemptsText: '4',
      checkpoint: false,
      idempotencyKey: 'feed-1',
      onFailure: { network: 'open-home' as const }
    }
    const switched = switchWorkflowNodeKind(withValues, 'wait-for-event')
    expect(switched.kind).toBe('wait-for-event')
    expect(switched.timeoutMsText).toBe('45000')
    expect(switched.maxAttemptsText).toBe('4')
    expect(switched.checkpoint).toBe(false)
    expect(switched.idempotencyKey).toBe('feed-1')
    expect(switched.onFailure).toEqual({ network: 'open-home' })
    expect(switched.url).toBe('https://example.com/feed')
  })

  it('写盘时只保留当前类型的专属字段', () => {
    const node = createWorkflowNodeForm('navigate', ['open-home'])
    const switched = switchWorkflowNodeKind(
      { ...node, url: 'https://example.com/', next: 'open-home' },
      'complete'
    )
    const written = workflowNodeFormToNode(switched)
    expect(written.kind).toBe('complete')
    expect('url' in written).toBe(false)
    expect('next' in written).toBe(false)
  })

  it('检测入口与 next 的悬空引用', () => {
    const form = projectToForm(defaultDraft())
    const dangling = findDanglingNodeReferences({
      ...form.workflow,
      entryNodeId: 'missing-entry',
      nodes: form.workflow.nodes.map((node, index) =>
        index === 0 ? { ...node, next: 'missing-next' } : node
      )
    })
    expect(dangling.map((item) => item.to)).toEqual([
      'missing-entry',
      'missing-next'
    ])
  })

  it('删除被引用节点时能列出引用来源', () => {
    const form = projectToForm(defaultDraft())
    const references = findNodeReferences(form.workflow, 'finished')
    expect(references.length).toBeGreaterThan(0)
    expect(references.join()).toContain('wait-complete')
  })

  it('重命名节点同步更新 next、entryNodeId 与 onFailure', () => {
    const form = projectToForm(defaultDraft())
    const withFailure = {
      ...form.workflow,
      nodes: form.workflow.nodes.map((node) =>
        node.id === 'open-home'
          ? { ...node, onFailure: { network: 'finished' as const } }
          : node
      )
    }
    const renamed = renameWorkflowNode(withFailure, 'finished', 'done')
    expect(renamed.entryNodeId).toBe('open-home')
    expect(renamed.nodes.find((node) => node.id === 'done')).toBeDefined()
    expect(
      renamed.nodes.find((node) => node.id === 'wait-complete')?.next
    ).toBe('done')
    expect(
      renamed.nodes.find((node) => node.id === 'open-home')?.onFailure
    ).toEqual({ network: 'done' })
  })

  it('节点表单与契约节点往返保持字段一致', () => {
    const draft = defaultDraft()
    const node = draft.workflow.nodes[0]
    expect(node).toBeDefined()
    if (!node) {
      return
    }
    expect(workflowNodeFormToNode(workflowNodeToForm(node))).toEqual(node)
  })
})

describe('settings-validation: Project', () => {
  it('默认草稿没有校验错误', () => {
    const result = validateProjectForm(projectToForm(defaultDraft()))
    expect(result.issues).toEqual([])
  })

  it('空名称与非法启动页面会被定位到具体字段', () => {
    const form = projectToForm(defaultDraft())
    const result = validateProjectForm({
      ...form,
      base: {
        ...form.base,
        name: '   ',
        startupPagesText: 'ftp://example.com'
      }
    })
    expect(result.errors['base.name']).toBeTruthy()
    expect(result.errors['base.startupPages.0']).toBeTruthy()
    expect(projectErrorSections(result).has('base')).toBe(true)
  })

  it('schedule 模式切换后校验调度字段', () => {
    const form = projectToForm(defaultDraft())
    const scheduleForm = {
      ...form,
      runtime: {
        ...form.runtime,
        mode: 'schedule' as const,
        scheduleKind: 'daily' as const,
        dailyTimesText: '25:99'
      }
    }
    expect(
      validateProjectForm(scheduleForm).errors['runtime.dailyTimes.0']
    ).toBeTruthy()

    const intervalForm = {
      ...form,
      runtime: {
        ...form.runtime,
        mode: 'schedule' as const,
        scheduleKind: 'interval' as const,
        everyMinutesText: '0'
      }
    }
    expect(
      validateProjectForm(intervalForm).errors['runtime.everyMinutes']
    ).toBeTruthy()
  })

  it('基础退避大于最大退避时报错', () => {
    const form = projectToForm(defaultDraft())
    const result = validateProjectForm({
      ...form,
      retry: {
        ...form.retry,
        baseBackoffMsText: '5000',
        maxBackoffMsText: '1000'
      }
    })
    expect(result.errors['retry.baseBackoffMs']).toBe(
      '基础退避不能大于最大退避'
    )
  })

  it('非精确 Origin 会被拒绝', () => {
    const form = projectToForm(defaultDraft())
    const result = validateProjectForm({
      ...form,
      capabilities: {
        ...form.capabilities,
        origins: [
          {
            origin: 'https://example.com/path',
            overrides: form.capabilities.origins[0]?.overrides ?? {
              popups: 'inherit',
              downloads: 'inherit',
              notifications: 'inherit',
              geolocation: 'inherit',
              media: 'inherit',
              clipboardRead: 'inherit',
              fullscreen: 'inherit'
            }
          }
        ]
      }
    })
    expect(result.errors['capabilities.origins.0.origin']).toBeTruthy()
  })

  it('重复节点 ID 与悬空 next 都会报错', () => {
    const form = projectToForm(defaultDraft())
    const result = validateProjectForm({
      ...form,
      workflow: {
        ...form.workflow,
        nodes: form.workflow.nodes.map((node, index) =>
          index === 0 ? { ...node, id: 'finished', next: 'missing-node' } : node
        )
      }
    })
    expect(result.issues.some((issue) => issue.message.includes('重复'))).toBe(
      true
    )
    expect(
      result.issues.some((issue) => issue.message.includes('不存在的节点'))
    ).toBe(true)
  })

  it('字段锚点 id 与校验路径一致', () => {
    expect(fieldAnchorId('workflow.nodes.0.url')).toBe(
      'field-workflow-nodes-0-url'
    )
  })
})

describe('settings-validation: Strategy', () => {
  it('默认 manifest 通过校验', () => {
    const manifest = createDefaultStrategyManifest()
    const result = validateStrategyForm(
      strategyToForm(manifest, 'agenticStrategy.log("ok")')
    )
    expect(result.issues).toEqual([])
  })

  it('源码语法错误会阻止保存', () => {
    expect(checkStrategySourceSyntax('agenticStrategy.log("ok")')).toBeNull()
    expect(checkStrategySourceSyntax('function (')).not.toBeNull()
    const manifest = createDefaultStrategyManifest()
    const result = validateStrategyForm(strategyToForm(manifest, 'function ('))
    expect(result.errors.source).toContain('源码语法错误')
  })

  it('config 值解析失败会给出字段级错误', () => {
    const manifest = createDefaultStrategyManifest()
    const form = strategyToForm(manifest, 'agenticStrategy.log("ok")')
    const withConfig = {
      ...form,
      manifest: {
        ...form.manifest,
        config: [
          { key: 'threshold', type: 'number' as const, valueText: 'abc' },
          { key: 'options', type: 'json' as const, valueText: '{' }
        ]
      }
    }
    const result = validateStrategyForm(withConfig)
    expect(result.errors['manifest.config.0']).toBe('请输入合法数字')
    expect(result.errors['manifest.config.1']).toBe('JSON 解析失败')
  })

  it('manifest 与表单往返保持一致', () => {
    const manifest = createDefaultStrategyManifest()
    const form = strategyToForm(manifest, 'agenticStrategy.log("ok")')
    expect(formToStrategy(form, manifest)).toEqual(manifest)
  })

  it('config 的四种类型都能正确解析', () => {
    const { config, errors } = parseStrategyConfig([
      { key: 'text', type: 'string', valueText: 'hello' },
      { key: 'count', type: 'number', valueText: '12' },
      { key: 'flag', type: 'boolean', valueText: 'false' },
      { key: 'nested', type: 'json', valueText: '{"a":[1,2]}' },
      { key: '', type: 'string', valueText: 'x' }
    ])
    expect(errors[4]).toBe('键名不能为空')
    expect(config).toEqual({
      text: 'hello',
      count: 12,
      flag: false,
      nested: { a: [1, 2] }
    })
  })
})
