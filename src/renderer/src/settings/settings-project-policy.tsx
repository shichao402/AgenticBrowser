import type {
  CapabilitySettings,
  ProjectStrategyResolution,
  StrategyWorkspaceSnapshot
} from '../../../shared/contracts'
import { CAPABILITY_ITEMS } from '../app-format'
import {
  Field,
  FormSection,
  RowActions,
  SelectInput,
  Switch,
  TextArea
} from './settings-fields'
import type {
  CapabilityDecision,
  ProjectForm,
  StrategyPinForm
} from './settings-model'
import {
  RESOURCE_TYPE_OPTIONS,
  createCssRuleForm,
  createNetworkRuleForm,
  createOriginFormRule
} from './settings-model'

export interface ProjectCapabilityFieldsProps {
  form: ProjectForm
  errors: Record<string, string>
  locked: boolean
  onChange: (updater: (current: ProjectForm) => ProjectForm) => void
}

/** 能力策略：默认开关 + 精确 Origin 覆盖表。 */
export function ProjectCapabilityFields({
  form,
  errors,
  locked,
  onChange
}: ProjectCapabilityFieldsProps): React.JSX.Element {
  const updateCapabilities = (
    updater: (
      current: ProjectForm['capabilities']
    ) => ProjectForm['capabilities']
  ): void => {
    onChange((current) => ({
      ...current,
      capabilities: updater(current.capabilities)
    }))
  }

  const toggleDefault = (
    key: keyof CapabilitySettings,
    value: boolean
  ): void => {
    updateCapabilities((capabilities) => ({
      ...capabilities,
      defaults: { ...capabilities.defaults, [key]: value }
    }))
  }

  const updateOrigin = (
    index: number,
    patch: Partial<ProjectForm['capabilities']['origins'][number]>
  ): void => {
    updateCapabilities((capabilities) => ({
      ...capabilities,
      origins: capabilities.origins.map((rule, current) =>
        current === index ? { ...rule, ...patch } : rule
      )
    }))
  }

  const setOriginDecision = (
    index: number,
    key: keyof CapabilitySettings,
    decision: CapabilityDecision
  ): void => {
    updateCapabilities((capabilities) => ({
      ...capabilities,
      origins: capabilities.origins.map((rule, current) =>
        current === index
          ? { ...rule, overrides: { ...rule.overrides, [key]: decision } }
          : rule
      )
    }))
  }

  const addOrigin = (): void => {
    updateCapabilities((capabilities) => ({
      ...capabilities,
      origins: [...capabilities.origins, createOriginFormRule()]
    }))
  }

  const removeOrigin = (index: number): void => {
    updateCapabilities((capabilities) => ({
      ...capabilities,
      origins: capabilities.origins.filter((_, current) => current !== index)
    }))
  }

  return (
    <FormSection
      title="能力策略"
      description="默认策略作用于所有站点；Origin 覆盖必须填写精确 Origin，子域不会继承。"
      actions={
        <button type="button" disabled={locked} onClick={addOrigin}>
          + 添加 Origin 覆盖
        </button>
      }
    >
      <div className="settings-capability-grid">
        {CAPABILITY_ITEMS.map((item) => (
          <Switch
            key={item.key}
            id={`field-capabilities-defaults-${item.key}`}
            label={item.label}
            checked={form.capabilities.defaults[item.key]}
            disabled={locked}
            onChange={(checked) => toggleDefault(item.key, checked)}
          />
        ))}
      </div>

      {form.capabilities.origins.length === 0 ? (
        <p className="settings-empty">
          未配置 Origin 覆盖，全部站点使用默认策略。
        </p>
      ) : (
        <div className="settings-table-wrap">
          <table className="settings-table">
            <thead>
              <tr>
                <th>Origin</th>
                {CAPABILITY_ITEMS.map((item) => (
                  <th key={item.key} title={item.label}>
                    {item.label}
                  </th>
                ))}
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {form.capabilities.origins.map((rule, index) => (
                <tr key={`origin-${index}`}>
                  <td>
                    <input
                      id={`field-capabilities-origins-${index}-origin`}
                      type="text"
                      spellCheck={false}
                      placeholder="https://example.com"
                      value={rule.origin}
                      disabled={locked}
                      onChange={(event) =>
                        updateOrigin(index, { origin: event.target.value })
                      }
                    />
                    {errors[`capabilities.origins.${index}.origin`] ? (
                      <p className="settings-error" role="alert">
                        {errors[`capabilities.origins.${index}.origin`]}
                      </p>
                    ) : null}
                  </td>
                  {CAPABILITY_ITEMS.map((item) => (
                    <td key={item.key}>
                      <select
                        aria-label={`${rule.origin || `第 ${index + 1} 行`} 的 ${item.label}`}
                        value={rule.overrides[item.key]}
                        disabled={locked}
                        onChange={(event) =>
                          setOriginDecision(
                            index,
                            item.key,
                            event.target.value as CapabilityDecision
                          )
                        }
                      >
                        <option value="inherit">继承</option>
                        <option value="allow">允许</option>
                        <option value="deny">拒绝</option>
                      </select>
                    </td>
                  ))}
                  <td>
                    <RowActions
                      onRemove={() => removeOrigin(index)}
                      removeDisabled={locked}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="settings-hint">
        Origin 形如 https://example.com 或 https://example.com:8443；填写路径、
        通配符或缺少协议都会被视为非法。覆盖项选「继承」表示不声明覆盖。
      </p>
    </FormSection>
  )
}

export interface ProjectFilterFieldsProps {
  form: ProjectForm
  errors: Record<string, string>
  locked: boolean
  onChange: (updater: (current: ProjectForm) => ProjectForm) => void
}

/** 内容过滤：网络规则表与 CSS 隐藏规则表。 */
export function ProjectFilterFields({
  form,
  errors,
  locked,
  onChange
}: ProjectFilterFieldsProps): React.JSX.Element {
  const updateFilter = (
    updater: (current: ProjectForm['filter']) => ProjectForm['filter']
  ): void => {
    onChange((current) => ({ ...current, filter: updater(current.filter) }))
  }

  const addNetworkRule = (): void => {
    updateFilter((filter) => ({
      ...filter,
      networkRules: [
        ...filter.networkRules,
        createNetworkRuleForm(filter.networkRules.map((rule) => rule.id))
      ]
    }))
  }

  const addCssRule = (): void => {
    updateFilter((filter) => ({
      ...filter,
      cssRules: [
        ...filter.cssRules,
        createCssRuleForm(filter.cssRules.map((rule) => rule.id))
      ]
    }))
  }

  return (
    <FormSection
      title="内容过滤"
      description="在页面加载阶段拦截指定资源，或用 CSS 隐藏指定元素；规则顺序即匹配顺序。"
      actions={
        <div className="settings-inline-actions">
          <button type="button" disabled={locked} onClick={addNetworkRule}>
            + 网络规则
          </button>
          <button type="button" disabled={locked} onClick={addCssRule}>
            + CSS 规则
          </button>
        </div>
      }
    >
      <Switch
        id="field-filter-enabled"
        label={form.filter.enabled ? '过滤器已开启' : '过滤器已关闭'}
        checked={form.filter.enabled}
        disabled={locked}
        onChange={(checked) =>
          updateFilter((filter) => ({ ...filter, enabled: checked }))
        }
      />

      <h3 className="settings-subhead">网络规则</h3>
      {form.filter.networkRules.length === 0 ? (
        <p className="settings-empty">尚无网络规则</p>
      ) : (
        <div className="settings-table-wrap">
          <table className="settings-table">
            <thead>
              <tr>
                <th>规则 ID</th>
                <th>动作</th>
                <th>URL 模式</th>
                <th>资源类型</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {form.filter.networkRules.map((rule, index) => (
                <tr key={`network-${index}`}>
                  <td>
                    <input
                      id={`field-filter-networkRules-${index}-id`}
                      type="text"
                      value={rule.id}
                      spellCheck={false}
                      disabled={locked}
                      onChange={(event) =>
                        updateFilter((filter) => ({
                          ...filter,
                          networkRules: filter.networkRules.map(
                            (item, current) =>
                              current === index
                                ? { ...item, id: event.target.value }
                                : item
                          )
                        }))
                      }
                    />
                    {errors[`filter.networkRules.${index}.id`] ? (
                      <p className="settings-error">
                        {errors[`filter.networkRules.${index}.id`]}
                      </p>
                    ) : null}
                  </td>
                  <td>
                    <SelectInput
                      id={`field-filter-networkRules-${index}-action`}
                      value={rule.action}
                      options={[
                        { value: 'block', label: '拦截' },
                        { value: 'allow', label: '放行' }
                      ]}
                      disabled={locked}
                      onChange={(value) =>
                        updateFilter((filter) => ({
                          ...filter,
                          networkRules: filter.networkRules.map(
                            (item, current) =>
                              current === index
                                ? { ...item, action: value }
                                : item
                          )
                        }))
                      }
                    />
                  </td>
                  <td>
                    <input
                      id={`field-filter-networkRules-${index}-urlPattern`}
                      type="text"
                      value={rule.urlPattern}
                      spellCheck={false}
                      disabled={locked}
                      onChange={(event) =>
                        updateFilter((filter) => ({
                          ...filter,
                          networkRules: filter.networkRules.map(
                            (item, current) =>
                              current === index
                                ? { ...item, urlPattern: event.target.value }
                                : item
                          )
                        }))
                      }
                    />
                    {errors[`filter.networkRules.${index}.urlPattern`] ? (
                      <p className="settings-error">
                        {errors[`filter.networkRules.${index}.urlPattern`]}
                      </p>
                    ) : null}
                  </td>
                  <td>
                    <div className="settings-checkbox-list">
                      {RESOURCE_TYPE_OPTIONS.map((option) => (
                        <label key={option.value}>
                          <input
                            type="checkbox"
                            checked={rule.resourceTypes.includes(option.value)}
                            disabled={locked}
                            onChange={(event) =>
                              updateFilter((filter) => ({
                                ...filter,
                                networkRules: filter.networkRules.map(
                                  (item, current) => {
                                    if (current !== index) {
                                      return item
                                    }
                                    const next = new Set(item.resourceTypes)
                                    if (event.target.checked) {
                                      next.add(option.value)
                                    } else {
                                      next.delete(option.value)
                                    }
                                    return { ...item, resourceTypes: [...next] }
                                  }
                                )
                              }))
                            }
                          />
                          {option.label}
                        </label>
                      ))}
                    </div>
                    {errors[`filter.networkRules.${index}.resourceTypes`] ? (
                      <p className="settings-error">
                        {errors[`filter.networkRules.${index}.resourceTypes`]}
                      </p>
                    ) : null}
                  </td>
                  <td>
                    <RowActions
                      onRemove={() =>
                        updateFilter((filter) => ({
                          ...filter,
                          networkRules: filter.networkRules.filter(
                            (_, current) => current !== index
                          )
                        }))
                      }
                      removeDisabled={locked}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="settings-subhead">CSS 隐藏规则</h3>
      {form.filter.cssRules.length === 0 ? (
        <p className="settings-empty">尚无 CSS 规则</p>
      ) : (
        <div className="settings-table-wrap">
          <table className="settings-table">
            <thead>
              <tr>
                <th>规则 ID</th>
                <th>URL 模式</th>
                <th>选择器</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {form.filter.cssRules.map((rule, index) => (
                <tr key={`css-${index}`}>
                  <td>
                    <input
                      id={`field-filter-cssRules-${index}-id`}
                      type="text"
                      value={rule.id}
                      spellCheck={false}
                      disabled={locked}
                      onChange={(event) =>
                        updateFilter((filter) => ({
                          ...filter,
                          cssRules: filter.cssRules.map((item, current) =>
                            current === index
                              ? { ...item, id: event.target.value }
                              : item
                          )
                        }))
                      }
                    />
                    {errors[`filter.cssRules.${index}.id`] ? (
                      <p className="settings-error">
                        {errors[`filter.cssRules.${index}.id`]}
                      </p>
                    ) : null}
                  </td>
                  <td>
                    <input
                      id={`field-filter-cssRules-${index}-urlPattern`}
                      type="text"
                      value={rule.urlPattern}
                      spellCheck={false}
                      disabled={locked}
                      onChange={(event) =>
                        updateFilter((filter) => ({
                          ...filter,
                          cssRules: filter.cssRules.map((item, current) =>
                            current === index
                              ? { ...item, urlPattern: event.target.value }
                              : item
                          )
                        }))
                      }
                    />
                    {errors[`filter.cssRules.${index}.urlPattern`] ? (
                      <p className="settings-error">
                        {errors[`filter.cssRules.${index}.urlPattern`]}
                      </p>
                    ) : null}
                  </td>
                  <td>
                    <TextArea
                      id={`field-filter-cssRules-${index}-selectors`}
                      rows={3}
                      monospace
                      value={rule.selectorsText}
                      disabled={locked}
                      placeholder={'.ad-banner\n#popup'}
                      onChange={(value) =>
                        updateFilter((filter) => ({
                          ...filter,
                          cssRules: filter.cssRules.map((item, current) =>
                            current === index
                              ? { ...item, selectorsText: value }
                              : item
                          )
                        }))
                      }
                    />
                    {errors[`filter.cssRules.${index}.selectors`] ? (
                      <p className="settings-error">
                        {errors[`filter.cssRules.${index}.selectors`]}
                      </p>
                    ) : null}
                  </td>
                  <td>
                    <RowActions
                      onRemove={() =>
                        updateFilter((filter) => ({
                          ...filter,
                          cssRules: filter.cssRules.filter(
                            (_, current) => current !== index
                          )
                        }))
                      }
                      removeDisabled={locked}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </FormSection>
  )
}

export interface ProjectStrategyPinsFieldsProps {
  form: ProjectForm
  errors: Record<string, string>
  locked: boolean
  registry: StrategyWorkspaceSnapshot | null
  resolutions: ProjectStrategyResolution[]
  onChange: (updater: (current: ProjectForm) => ProjectForm) => void
}

/** 策略固定：把策略 ID 固定到具体版本，运行期 allowlist 由此生成。 */
export function ProjectStrategyPinsFields({
  form,
  errors,
  locked,
  registry,
  resolutions,
  onChange
}: ProjectStrategyPinsFieldsProps): React.JSX.Element {
  const options = (registry?.strategies ?? []).map((definition) => ({
    value: definition.manifest.id,
    label: `${definition.manifest.name}（${definition.manifest.version}）`
  }))

  const updatePins = (
    updater: (pins: StrategyPinForm[]) => StrategyPinForm[]
  ): void => {
    onChange((current) => ({
      ...current,
      strategies: updater(current.strategies)
    }))
  }

  const addPin = (): void => {
    const taken = new Set(form.strategies.map((pin) => pin.id))
    const candidate = options.find((option) => !taken.has(option.value))
    const version =
      registry?.strategies.find(
        (definition) => definition.manifest.id === candidate?.value
      )?.manifest.version ?? ''
    updatePins((pins) => [...pins, { id: candidate?.value ?? '', version }])
  }

  return (
    <FormSection
      title="固定的策略版本"
      description="Project 只运行此处固定的策略版本；版本与注册表不一致时会标记 version-mismatch。"
      actions={
        <button
          type="button"
          disabled={locked || options.length === 0}
          onClick={addPin}
        >
          + 固定策略
        </button>
      }
    >
      {form.strategies.length === 0 ? (
        <p className="settings-empty">尚未固定任何策略，运行时不加载策略。</p>
      ) : (
        <div className="settings-table-wrap">
          <table className="settings-table">
            <thead>
              <tr>
                <th>策略</th>
                <th>固定版本</th>
                <th>注册表版本</th>
                <th>状态</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {form.strategies.map((pin, index) => {
                const resolution = resolutions.find(
                  (item) => item.strategyId === pin.id
                )
                const registryVersion =
                  registry?.strategies.find(
                    (definition) => definition.manifest.id === pin.id
                  )?.manifest.version ?? null
                return (
                  <tr key={`pin-${index}`}>
                    <td>
                      <SelectInput
                        id={`field-strategies-${index}-id`}
                        value={pin.id}
                        options={options}
                        disabled={locked}
                        allowEmpty="请选择策略"
                        onChange={(value) => {
                          const version =
                            registry?.strategies.find(
                              (definition) => definition.manifest.id === value
                            )?.manifest.version ?? pin.version
                          updatePins((pins) =>
                            pins.map((item, current) =>
                              current === index
                                ? { ...item, id: value, version }
                                : item
                            )
                          )
                        }}
                      />
                      {errors[`strategies.${index}.id`] ? (
                        <p className="settings-error">
                          {errors[`strategies.${index}.id`]}
                        </p>
                      ) : null}
                    </td>
                    <td>
                      <input
                        id={`field-strategies-${index}-version`}
                        type="text"
                        value={pin.version}
                        spellCheck={false}
                        placeholder={registryVersion ?? ''}
                        disabled={locked}
                        onChange={(event) =>
                          updatePins((pins) =>
                            pins.map((item, current) =>
                              current === index
                                ? { ...item, version: event.target.value }
                                : item
                            )
                          )
                        }
                      />
                      {errors[`strategies.${index}.version`] ? (
                        <p className="settings-error">
                          {errors[`strategies.${index}.version`]}
                        </p>
                      ) : null}
                    </td>
                    <td>
                      <code>{registryVersion ?? '未注册'}</code>
                    </td>
                    <td>
                      <span
                        className={`settings-status settings-status-${
                          resolution?.status ?? 'ready'
                        }`}
                      >
                        {resolution?.status ??
                          (registryVersion === null
                            ? 'missing'
                            : registryVersion === pin.version
                              ? 'ready'
                              : 'version-mismatch')}
                      </span>
                    </td>
                    <td>
                      <RowActions
                        onRemove={() =>
                          updatePins((pins) =>
                            pins.filter((_, current) => current !== index)
                          )
                        }
                        removeDisabled={locked}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <Field
        label="固定策略 ID"
        path="strategies"
        hint="策略注册表来源：Strategy 工作区"
      >
        <p className="settings-readonly-value">
          {options.length === 0
            ? '注册表为空，请先在策略分区创建 Strategy'
            : `可选 ${options.length} 个策略`}
        </p>
      </Field>
    </FormSection>
  )
}
