import {
  Field,
  FormSection,
  RowActions,
  SelectInput,
  TextArea,
  TextInput
} from './settings-fields'
import type { StrategyForm } from './settings-model'
import {
  STRATEGY_FRAME_OPTIONS,
  STRATEGY_PERMISSION_OPTIONS,
  STRATEGY_RUN_AT_OPTIONS,
  createStrategyConfigEntry
} from './settings-model'
import type { StrategyPermission } from '../../../shared/contracts'

export interface StrategyManifestFieldsProps {
  form: StrategyForm
  errors: Record<string, string>
  locked: boolean
  onChange: (updater: (current: StrategyForm) => StrategyForm) => void
}

function errorOf(
  errors: Record<string, string>,
  path: string
): string | undefined {
  return errors[path]
}

/** Manifest 分区：身份、匹配模式、注入时机、权限、config 与超时。 */
export function StrategyManifestFields({
  form,
  errors,
  locked,
  onChange
}: StrategyManifestFieldsProps): React.JSX.Element {
  const manifest = form.manifest

  const updateManifest = (
    updater: (current: StrategyForm['manifest']) => StrategyForm['manifest']
  ): void => {
    onChange((current) => ({
      ...current,
      manifest: updater(current.manifest)
    }))
  }

  const togglePermission = (
    permission: StrategyPermission,
    checked: boolean
  ): void => {
    updateManifest((current) => {
      const next = new Set(current.permissions)
      if (checked) {
        next.add(permission)
      } else {
        next.delete(permission)
      }
      return { ...current, permissions: [...next] }
    })
  }

  const updateConfigEntry = (
    index: number,
    patch: Partial<StrategyForm['manifest']['config'][number]>
  ): void => {
    updateManifest((current) => ({
      ...current,
      config: current.config.map((entry, currentIndex) =>
        currentIndex === index ? { ...entry, ...patch } : entry
      )
    }))
  }

  return (
    <FormSection
      title="Manifest"
      description="声明匹配范围、注入时机与可用权限；运行期 allowlist 由 Project 固定版本生成。"
    >
      <div className="settings-grid settings-grid-3">
        <Field
          label="Strategy ID"
          path="manifest.id"
          hint="编辑既有 Strategy 时不可修改"
          error={errorOf(errors, 'manifest.id')}
        >
          <TextInput
            id="field-manifest-id"
            value={manifest.id}
            monospace
            readOnly
            disabled
            onChange={(value) =>
              updateManifest((current) => ({ ...current, id: value }))
            }
          />
        </Field>

        <Field
          label="名称"
          path="manifest.name"
          error={errorOf(errors, 'manifest.name')}
        >
          <TextInput
            id="field-manifest-name"
            value={manifest.name}
            disabled={locked}
            onChange={(value) =>
              updateManifest((current) => ({ ...current, name: value }))
            }
          />
        </Field>

        <Field
          label="版本"
          path="manifest.version"
          hint="Project 按版本固定策略，变更逻辑时请递增"
          error={errorOf(errors, 'manifest.version')}
        >
          <TextInput
            id="field-manifest-version"
            value={manifest.version}
            monospace
            disabled={locked}
            onChange={(value) =>
              updateManifest((current) => ({ ...current, version: value }))
            }
          />
        </Field>
      </div>

      <Field
        label="匹配模式（matches）"
        path="manifest.matches"
        hint="每行一个匹配模式，支持 * 通配；例如 https://example.com/*"
        error={errorOf(errors, 'manifest.matches')}
      >
        <TextArea
          id="field-manifest-matches"
          rows={4}
          monospace
          value={manifest.matchesText}
          disabled={locked}
          placeholder="https://example.com/*"
          onChange={(value) =>
            updateManifest((current) => ({ ...current, matchesText: value }))
          }
        />
      </Field>

      <div className="settings-grid settings-grid-2">
        <Field
          label="排除模式（excludes）"
          path="manifest.excludes"
          hint="命中排除模式时不注入，优先级高于 matches"
          error={errorOf(errors, 'manifest.excludes')}
        >
          <TextArea
            id="field-manifest-excludes"
            rows={3}
            monospace
            value={manifest.excludesText}
            disabled={locked}
            placeholder="https://example.com/logout*"
            onChange={(value) =>
              updateManifest((current) => ({ ...current, excludesText: value }))
            }
          />
        </Field>

        <Field
          label="网络匹配（networkMatches）"
          path="manifest.networkMatches"
          hint="声明该策略关注的请求 URL 模式，需配合 network.request 权限使用"
          error={errorOf(errors, 'manifest.networkMatches')}
        >
          <TextArea
            id="field-manifest-networkMatches"
            rows={3}
            monospace
            value={manifest.networkMatchesText}
            disabled={locked}
            placeholder="https://api.example.com/*"
            onChange={(value) =>
              updateManifest((current) => ({
                ...current,
                networkMatchesText: value
              }))
            }
          />
        </Field>
      </div>

      <div className="settings-grid settings-grid-2">
        <Field
          label="注入时机（runAt）"
          path="manifest.runAt"
          error={errorOf(errors, 'manifest.runAt')}
        >
          <div className="settings-radio-group" role="radiogroup">
            {STRATEGY_RUN_AT_OPTIONS.map((option) => (
              <label key={option.value} className="settings-radio">
                <input
                  type="radio"
                  name="strategy-run-at"
                  value={option.value}
                  checked={manifest.runAt === option.value}
                  disabled={locked}
                  onChange={() =>
                    updateManifest((current) => ({
                      ...current,
                      runAt: option.value
                    }))
                  }
                />
                <span>
                  {option.label}
                  <small>{option.hint}</small>
                </span>
              </label>
            ))}
          </div>
        </Field>

        <Field
          label="作用框架（frames）"
          path="manifest.frames"
          error={errorOf(errors, 'manifest.frames')}
        >
          <div className="settings-radio-group" role="radiogroup">
            {STRATEGY_FRAME_OPTIONS.map((option) => (
              <label key={option.value} className="settings-radio">
                <input
                  type="radio"
                  name="strategy-frames"
                  value={option.value}
                  checked={manifest.frames === option.value}
                  disabled={locked}
                  onChange={() =>
                    updateManifest((current) => ({
                      ...current,
                      frames: option.value
                    }))
                  }
                />
                <span>
                  {option.label}
                  <small>{option.hint}</small>
                </span>
              </label>
            ))}
          </div>
        </Field>
      </div>

      <fieldset className="settings-permissions">
        <legend>权限声明（permissions）</legend>
        <p className="settings-hint">
          dom.read / dom.write / dom.click 仅用于声明与审计，不构成强制隔离；
          其余权限会解锁对应的宿主能力。
        </p>
        <div className="settings-permission-list">
          {STRATEGY_PERMISSION_OPTIONS.map((option) => (
            <label key={option.value} className="settings-permission">
              <input
                type="checkbox"
                checked={manifest.permissions.includes(option.value)}
                disabled={locked}
                onChange={(event) =>
                  togglePermission(option.value, event.target.checked)
                }
              />
              <span>
                <code>{option.label}</code>
                <small>{option.hint}</small>
              </span>
            </label>
          ))}
        </div>
        {errors['manifest.permissions'] ? (
          <p className="settings-error" role="alert">
            {errors['manifest.permissions']}
          </p>
        ) : null}
      </fieldset>

      <div className="settings-grid settings-grid-2">
        <Field
          label="启动超时（毫秒）"
          path="manifest.startupMs"
          hint="策略加载到首个心跳的宽限期"
          error={errorOf(errors, 'manifest.startupMs')}
        >
          <input
            id="field-manifest-startupMs"
            type="number"
            min={1}
            step={1000}
            value={manifest.startupMsText}
            disabled={locked}
            onChange={(event) =>
              updateManifest((current) => ({
                ...current,
                startupMsText: event.target.value
              }))
            }
          />
        </Field>

        <Field
          label="心跳间隔（毫秒）"
          path="manifest.heartbeatMs"
          hint="心跳超时判定为 2 × 该值"
          error={errorOf(errors, 'manifest.heartbeatMs')}
        >
          <input
            id="field-manifest-heartbeatMs"
            type="number"
            min={1}
            step={1000}
            value={manifest.heartbeatMsText}
            disabled={locked}
            onChange={(event) =>
              updateManifest((current) => ({
                ...current,
                heartbeatMsText: event.target.value
              }))
            }
          />
        </Field>
      </div>

      <fieldset className="settings-config">
        <legend>配置项（config）</legend>
        <p className="settings-hint">
          键值对会通过 config.read 下发到策略；
          「JSON」类型用于对象或数组，解析失败会在字段旁提示。
        </p>
        {manifest.config.length === 0 ? (
          <p className="settings-empty">暂无配置项</p>
        ) : (
          <div className="settings-config-rows">
            {manifest.config.map((entry, index) => (
              <div className="settings-config-row" key={`config-${index}`}>
                <input
                  id={`field-manifest-config-${index}-key`}
                  type="text"
                  spellCheck={false}
                  placeholder="键名"
                  value={entry.key}
                  disabled={locked}
                  onChange={(event) =>
                    updateConfigEntry(index, { key: event.target.value })
                  }
                />
                <SelectInput
                  id={`field-manifest-config-${index}-type`}
                  value={entry.type}
                  options={[
                    { value: 'string', label: '字符串' },
                    { value: 'number', label: '数字' },
                    { value: 'boolean', label: '布尔' },
                    { value: 'json', label: 'JSON' }
                  ]}
                  disabled={locked}
                  onChange={(value) =>
                    updateConfigEntry(index, {
                      type: value,
                      valueText:
                        value === 'json' && entry.valueText.length === 0
                          ? '{}'
                          : value === 'boolean' &&
                              entry.valueText !== 'true' &&
                              entry.valueText !== 'false'
                            ? 'true'
                            : entry.valueText
                    })
                  }
                />
                {entry.type === 'json' ? (
                  <TextArea
                    id={`field-manifest-config-${index}-value`}
                    rows={3}
                    monospace
                    value={entry.valueText}
                    disabled={locked}
                    placeholder="{}"
                    onChange={(value) =>
                      updateConfigEntry(index, { valueText: value })
                    }
                  />
                ) : entry.type === 'boolean' ? (
                  <SelectInput
                    id={`field-manifest-config-${index}-value`}
                    value={
                      entry.valueText === 'true' || entry.valueText === 'false'
                        ? entry.valueText
                        : 'true'
                    }
                    options={[
                      { value: 'true', label: 'true' },
                      { value: 'false', label: 'false' }
                    ]}
                    disabled={locked}
                    onChange={(value) =>
                      updateConfigEntry(index, { valueText: value })
                    }
                  />
                ) : (
                  <input
                    id={`field-manifest-config-${index}-value`}
                    type={entry.type === 'number' ? 'number' : 'text'}
                    spellCheck={false}
                    placeholder={entry.type === 'number' ? '0' : '值'}
                    value={entry.valueText}
                    disabled={locked}
                    onChange={(event) =>
                      updateConfigEntry(index, {
                        valueText: event.target.value
                      })
                    }
                  />
                )}
                <RowActions
                  onRemove={() =>
                    updateManifest((current) => ({
                      ...current,
                      config: current.config.filter(
                        (_, currentIndex) => currentIndex !== index
                      )
                    }))
                  }
                  removeDisabled={locked}
                />
                {errors[`manifest.config.${index}`] ? (
                  <p
                    className="settings-error settings-config-error"
                    role="alert"
                  >
                    {errors[`manifest.config.${index}`]}
                  </p>
                ) : null}
                {errors[`manifest.config.${index}.key`] ? (
                  <p
                    className="settings-error settings-config-error"
                    role="alert"
                  >
                    {errors[`manifest.config.${index}.key`]}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          disabled={locked}
          onClick={() =>
            updateManifest((current) => ({
              ...current,
              config: [...current.config, createStrategyConfigEntry()]
            }))
          }
        >
          + 添加配置项
        </button>
      </fieldset>
    </FormSection>
  )
}

export interface StrategySourceFieldsProps {
  form: StrategyForm
  errors: Record<string, string>
  locked: boolean
  onChange: (updater: (current: StrategyForm) => StrategyForm) => void
}

/** 源码分区：隔离 world 内的执行体，保存前做语法检查。 */
export function StrategySourceFields({
  form,
  errors,
  locked,
  onChange
}: StrategySourceFieldsProps): React.JSX.Element {
  return (
    <FormSection
      title="策略源码"
      description="在隔离 world 中执行；可用宿主能力受上面声明的权限约束。语法错误会阻止保存。"
    >
      <Field
        label="源码"
        path="source"
        hint="保存成功后页面会被重载，以新版本重新注入。"
        error={errorOf(errors, 'source')}
      >
        <textarea
          id="field-source"
          className="settings-code"
          spellCheck={false}
          rows={18}
          value={form.source}
          disabled={locked}
          onChange={(event) =>
            onChange((current) => ({ ...current, source: event.target.value }))
          }
        />
      </Field>
    </FormSection>
  )
}
