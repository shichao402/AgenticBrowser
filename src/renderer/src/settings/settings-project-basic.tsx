import type { ProfileSummary } from '../../../shared/contracts'
import {
  Field,
  FormSection,
  SelectInput,
  Switch,
  TextArea,
  TextInput
} from './settings-fields'
import type { ProjectForm } from './settings-model'
import {
  COMMON_TIMEZONES,
  RUNTIME_MODE_OPTIONS,
  SCHEDULE_KIND_OPTIONS
} from './settings-model'

export interface ProjectFormSectionsProps {
  form: ProjectForm
  errors: Record<string, string>
  profiles: ProfileSummary[]
  locked: boolean
  onChange: (updater: (current: ProjectForm) => ProjectForm) => void
}

function errorOf(
  errors: Record<string, string>,
  path: string
): string | undefined {
  return errors[path]
}

/** 基础信息：id 只读、名称、Profile、启动页面、启用开关。 */
export function ProjectBaseFields({
  form,
  errors,
  profiles,
  locked,
  onChange
}: ProjectFormSectionsProps): React.JSX.Element {
  const updateBase = (patch: Partial<ProjectForm['base']>): void => {
    onChange((current) => ({ ...current, base: { ...current.base, ...patch } }))
  }

  const startupPages = form.base.startupPagesText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const profileOptions = profiles.map((profile) => ({
    value: profile.id,
    label: `${profile.name}${profile.active ? '（活动）' : ''}`
  }))

  return (
    <FormSection
      title="基础信息"
      description="Project 的身份与 Profile 绑定；ID 创建后不可修改。"
    >
      <div className="settings-grid settings-grid-2">
        <Field
          label="Project ID"
          path="base.id"
          hint="编辑既有 Project 时不可修改，用于运行记录与检查点的稳定标识。"
          error={errorOf(errors, 'base.id')}
        >
          <TextInput
            id="field-base-id"
            value={form.base.id}
            readOnly
            monospace
            disabled
            onChange={(value) => updateBase({ id: value })}
          />
        </Field>

        <Field
          label="名称"
          path="base.name"
          error={errorOf(errors, 'base.name')}
        >
          <TextInput
            id="field-base-name"
            value={form.base.name}
            disabled={locked}
            onChange={(value) => updateBase({ name: value })}
          />
        </Field>
      </div>

      <div className="settings-grid settings-grid-2">
        <Field
          label="Profile"
          path="base.profileId"
          hint="Profile 决定浏览器数据目录与 Cookie，切换 Profile 会重建标签页。"
          error={errorOf(errors, 'base.profileId')}
        >
          <SelectInput
            id="field-base-profileId"
            value={form.base.profileId}
            options={profileOptions}
            disabled={locked}
            allowEmpty="请选择 Profile"
            onChange={(value) => updateBase({ profileId: value })}
          />
        </Field>

        <Field
          label="启用"
          path="base.enabled"
          hint={
            form.base.enabled
              ? '该 Project 可被自动触发'
              : '已停用：不会被 autostart / resident / schedule 自动触发'
          }
        >
          <Switch
            id="field-base-enabled"
            label={form.base.enabled ? '已启用' : '已停用'}
            checked={form.base.enabled}
            disabled={locked}
            onChange={(checked) => updateBase({ enabled: checked })}
          />
        </Field>
      </div>

      <Field
        label="启动页面"
        path="base.startupPages"
        hint="每行一个 URL，按顺序打开；运行时以启动快照为准。"
        error={errorOf(errors, 'base.startupPages.0')}
      >
        <TextArea
          id="field-base-startupPages"
          rows={4}
          value={form.base.startupPagesText}
          disabled={locked}
          placeholder="https://example.com/"
          onChange={(value) => updateBase({ startupPagesText: value })}
        />
      </Field>

      {startupPages.length > 0 ? (
        <ol className="settings-inline-list" aria-label="启动页面顺序">
          {startupPages.map((page, index) => (
            <li key={`${page}-${index}`}>
              <span>{index + 1}.</span>
              <code>{page}</code>
              {errors[`base.startupPages.${index}`] ? (
                <em>{errors[`base.startupPages.${index}`]}</em>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </FormSection>
  )
}

/** 运行时：触发模式、调度、时区、优先级与最长运行时长。 */
export function ProjectRuntimeFields({
  form,
  errors,
  locked,
  onChange
}: ProjectFormSectionsProps): React.JSX.Element {
  const updateRuntime = (patch: Partial<ProjectForm['runtime']>): void => {
    onChange((current) => ({
      ...current,
      runtime: { ...current.runtime, ...patch }
    }))
  }

  const currentMode = RUNTIME_MODE_OPTIONS.find(
    (option) => option.value === form.runtime.mode
  )

  return (
    <FormSection
      title="运行时"
      description="决定 Project 何时被触发，以及单次运行的时间预算。"
    >
      <Field
        label="触发模式"
        path="runtime.mode"
        hint={currentMode?.hint}
        error={errorOf(errors, 'runtime.mode')}
      >
        <div className="settings-radio-group" role="radiogroup">
          {RUNTIME_MODE_OPTIONS.map((option) => (
            <label key={option.value} className="settings-radio">
              <input
                type="radio"
                name="runtime-mode"
                value={option.value}
                checked={form.runtime.mode === option.value}
                disabled={locked}
                onChange={() => updateRuntime({ mode: option.value })}
              />
              <span>
                {option.label}
                <small>{option.hint}</small>
              </span>
            </label>
          ))}
        </div>
      </Field>

      {form.runtime.mode === 'schedule' ? (
        <div className="settings-subsection">
          <div className="settings-grid settings-grid-2">
            <Field
              label="调度形态"
              path="runtime.scheduleKind"
              error={errorOf(errors, 'runtime.scheduleKind')}
            >
              <SelectInput
                id="field-runtime-scheduleKind"
                value={form.runtime.scheduleKind}
                options={SCHEDULE_KIND_OPTIONS}
                disabled={locked}
                onChange={(value) => updateRuntime({ scheduleKind: value })}
              />
            </Field>

            {form.runtime.scheduleKind === 'interval' ? (
              <Field
                label="间隔（分钟）"
                path="runtime.everyMinutes"
                hint="上一次结束到下一次开始的间隔。"
                error={errorOf(errors, 'runtime.everyMinutes')}
              >
                <input
                  id="field-runtime-everyMinutes"
                  type="number"
                  min={1}
                  step={1}
                  value={form.runtime.everyMinutesText}
                  disabled={locked}
                  onChange={(event) =>
                    updateRuntime({ everyMinutesText: event.target.value })
                  }
                />
              </Field>
            ) : null}
          </div>

          {form.runtime.scheduleKind === 'daily' ? (
            <Field
              label="每日时间点"
              path="runtime.dailyTimes"
              hint="每行一个 24 小时制时间点，例如 09:30。时区取下方设置。"
              error={errorOf(errors, 'runtime.dailyTimes.0')}
            >
              <TextArea
                id="field-runtime-dailyTimes"
                rows={4}
                monospace
                value={form.runtime.dailyTimesText}
                disabled={locked}
                placeholder="09:30"
                onChange={(value) => updateRuntime({ dailyTimesText: value })}
              />
            </Field>
          ) : null}
        </div>
      ) : null}

      <div className="settings-grid settings-grid-3">
        <Field
          label="时区"
          path="runtime.timezone"
          hint="定时调度按此时区解释"
          error={errorOf(errors, 'runtime.timezone')}
        >
          <select
            id="field-runtime-timezone"
            value={form.runtime.timezone}
            disabled={locked}
            onChange={(event) =>
              updateRuntime({ timezone: event.target.value })
            }
          >
            {COMMON_TIMEZONES.includes(form.runtime.timezone) ? null : (
              <option value={form.runtime.timezone}>
                {form.runtime.timezone || '（未设置）'}
              </option>
            )}
            {COMMON_TIMEZONES.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="优先级"
          path="runtime.priority"
          hint="数值越大越先获得运行名额"
          error={errorOf(errors, 'runtime.priority')}
        >
          <input
            id="field-runtime-priority"
            type="number"
            step={1}
            value={form.runtime.priorityText}
            disabled={locked}
            onChange={(event) =>
              updateRuntime({ priorityText: event.target.value })
            }
          />
        </Field>

        <Field
          label="最长运行时长（分钟）"
          path="runtime.maxRunMs"
          hint="超时后按失败策略处理"
          error={errorOf(errors, 'runtime.maxRunMs')}
        >
          <input
            id="field-runtime-maxRunMs"
            type="number"
            min={1}
            step={1}
            value={form.runtime.maxRunMsText}
            disabled={locked}
            onChange={(event) =>
              updateRuntime({ maxRunMsText: event.target.value })
            }
          />
        </Field>
      </div>
    </FormSection>
  )
}

/** 输出：下载根目录、单文件容量与命名模板。 */
export function ProjectOutputFields({
  form,
  errors,
  locked,
  onChange
}: ProjectFormSectionsProps): React.JSX.Element {
  const updateOutput = (patch: Partial<ProjectForm['output']>): void => {
    onChange((current) => ({
      ...current,
      output: { ...current.output, ...patch }
    }))
  }

  return (
    <FormSection
      title="输出"
      description="下载文件的落盘位置与命名规则；同项目内文件名冲突会被自动去重。"
    >
      <Field
        label="输出目录"
        path="output.root"
        hint="绝对路径，目录不存在时在首次下载前创建。"
        error={errorOf(errors, 'output.root')}
      >
        <TextInput
          id="field-output-root"
          value={form.output.root}
          disabled={locked}
          monospace
          onChange={(value) => updateOutput({ root: value })}
        />
      </Field>

      <div className="settings-grid settings-grid-2">
        <Field
          label="单文件容量上限（MiB）"
          path="output.maxBytes"
          hint="超过上限的下载会被拒绝"
          error={errorOf(errors, 'output.maxBytes')}
        >
          <input
            id="field-output-maxBytes"
            type="number"
            min={1}
            step={1}
            value={form.output.maxBytesText}
            disabled={locked}
            onChange={(event) =>
              updateOutput({ maxBytesText: event.target.value })
            }
          />
        </Field>

        <Field
          label="文件命名模板"
          path="output.fileNameTemplate"
          hint="可用占位符：{fileName} 原始文件名、{postId} 业务条目 ID、{downloadId} 下载记录 ID、{timestamp} 完成时间戳"
          error={errorOf(errors, 'output.fileNameTemplate')}
        >
          <TextInput
            id="field-output-fileNameTemplate"
            value={form.output.fileNameTemplate}
            disabled={locked}
            monospace
            onChange={(value) => updateOutput({ fileNameTemplate: value })}
          />
        </Field>
      </div>
    </FormSection>
  )
}

/** 重试：连续失败阈值与指数退避。 */
export function ProjectRetryFields({
  form,
  errors,
  locked,
  onChange
}: ProjectFormSectionsProps): React.JSX.Element {
  const updateRetry = (patch: Partial<ProjectForm['retry']>): void => {
    onChange((current) => ({
      ...current,
      retry: { ...current.retry, ...patch }
    }))
  }

  return (
    <FormSection
      title="重试与退避"
      description="连续失败达到阈值后 Project 进入失败状态，需人工重启。"
    >
      <div className="settings-grid settings-grid-3">
        <Field
          label="最大连续失败次数"
          path="retry.maxConsecutiveFailures"
          error={errorOf(errors, 'retry.maxConsecutiveFailures')}
        >
          <input
            id="field-retry-maxConsecutiveFailures"
            type="number"
            min={0}
            step={1}
            value={form.retry.maxConsecutiveFailuresText}
            disabled={locked}
            onChange={(event) =>
              updateRetry({ maxConsecutiveFailuresText: event.target.value })
            }
          />
        </Field>

        <Field
          label="基础退避（毫秒）"
          path="retry.baseBackoffMs"
          error={errorOf(errors, 'retry.baseBackoffMs')}
        >
          <input
            id="field-retry-baseBackoffMs"
            type="number"
            min={0}
            step={100}
            value={form.retry.baseBackoffMsText}
            disabled={locked}
            onChange={(event) =>
              updateRetry({ baseBackoffMsText: event.target.value })
            }
          />
        </Field>

        <Field
          label="最大退避（毫秒）"
          path="retry.maxBackoffMs"
          hint="必须不小于基础退避"
          error={errorOf(errors, 'retry.maxBackoffMs')}
        >
          <input
            id="field-retry-maxBackoffMs"
            type="number"
            min={0}
            step={100}
            value={form.retry.maxBackoffMsText}
            disabled={locked}
            onChange={(event) =>
              updateRetry({ maxBackoffMsText: event.target.value })
            }
          />
        </Field>
      </div>
    </FormSection>
  )
}
