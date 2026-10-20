import type { ReactNode } from 'react'

/**
 * 设置页共享的表单控件。
 *
 * 这些控件只负责一致的视觉与可访问性（label 关联、错误文案、
 * 辅助说明），不含任何业务状态，方便各分区复用。
 */

export interface FieldProps {
  label: string
  /** 字段路径，同时用于生成 `htmlFor` 与错误锚点。 */
  path: string
  hint?: string | undefined
  error?: string | undefined
  children: ReactNode
}

/** 与校验层 `fieldAnchorId` 保持同一规则，避免两处漂移。 */
export function anchorId(path: string): string {
  return `field-${path.replace(/[^a-zA-Z0-9]+/g, '-')}`
}

export function Field({
  label,
  path,
  hint,
  error,
  children
}: FieldProps): React.JSX.Element {
  const id = anchorId(path)
  return (
    <div
      className={`settings-field ${error ? 'settings-field-error' : ''}`}
      id={id}
    >
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && !error ? <p className="settings-hint">{hint}</p> : null}
      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export interface TextInputProps {
  id: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  placeholder?: string
  readOnly?: boolean
  monospace?: boolean
}

export function TextInput({
  id,
  value,
  onChange,
  disabled,
  placeholder,
  readOnly,
  monospace
}: TextInputProps): React.JSX.Element {
  return (
    <input
      id={id}
      className={monospace ? 'settings-input-mono' : undefined}
      type="text"
      spellCheck={false}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      readOnly={readOnly}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

export interface SelectInputProps<T extends string> {
  id: string
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  disabled?: boolean
  allowEmpty?: string
}

export function SelectInput<T extends string>({
  id,
  value,
  options,
  onChange,
  disabled,
  allowEmpty
}: SelectInputProps<T>): React.JSX.Element {
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as T)}
    >
      {allowEmpty !== undefined ? <option value="">{allowEmpty}</option> : null}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

export interface TextAreaProps {
  id: string
  value: string
  onChange: (value: string) => void
  rows?: number
  disabled?: boolean
  monospace?: boolean
  placeholder?: string
}

export function TextArea({
  id,
  value,
  onChange,
  rows = 4,
  disabled,
  monospace,
  placeholder
}: TextAreaProps): React.JSX.Element {
  return (
    <textarea
      id={id}
      rows={rows}
      spellCheck={false}
      className={monospace ? 'settings-textarea-mono' : undefined}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

export interface SwitchProps {
  id: string
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
}

export function Switch({
  id,
  checked,
  onChange,
  label,
  disabled
}: SwitchProps): React.JSX.Element {
  return (
    <label className="settings-switch" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  )
}

export interface SectionProps {
  title: string
  description?: string
  children: ReactNode
  actions?: ReactNode
}

export function FormSection({
  title,
  description,
  children,
  actions
}: SectionProps): React.JSX.Element {
  return (
    <section className="settings-section">
      <header className="settings-section-head">
        <div>
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        {actions}
      </header>
      <div className="settings-section-body">{children}</div>
    </section>
  )
}

export interface RowActionsProps {
  onRemove?: () => void
  onMoveUp?: () => void
  onMoveDown?: () => void
  removeDisabled?: boolean
  removeLabel?: string
  canMoveUp?: boolean
  canMoveDown?: boolean
}

export function RowActions({
  onRemove,
  onMoveUp,
  onMoveDown,
  removeDisabled,
  removeLabel = '删除',
  canMoveUp,
  canMoveDown
}: RowActionsProps): React.JSX.Element {
  return (
    <div className="settings-row-actions">
      {onMoveUp ? (
        <button type="button" disabled={!canMoveUp} onClick={onMoveUp}>
          ↑
        </button>
      ) : null}
      {onMoveDown ? (
        <button type="button" disabled={!canMoveDown} onClick={onMoveDown}>
          ↓
        </button>
      ) : null}
      {onRemove ? (
        <button
          className="settings-danger"
          type="button"
          disabled={removeDisabled}
          onClick={onRemove}
        >
          {removeLabel}
        </button>
      ) : null}
    </div>
  )
}
