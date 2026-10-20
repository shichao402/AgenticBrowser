import { useMemo, useState } from 'react'

/**
 * 可选的 JSON 视图。
 *
 * 设计约束（需求 6）：
 * - 默认不渲染任何原始 JSON，只有用户主动切到「JSON」时才出现；
 * - 进入 JSON 视图时用「当前表单状态」序列化，而不是读磁盘旧版本；
 * - 解析失败时展示错误位置，并阻止切回表单与保存；
 * - 无法映射到表单的字段要显式提示，不能静默丢弃。
 */

export interface JsonViewProps {
  /** 当前表单序列化后的对象，用作 JSON 视图的初始文本。 */
  value: unknown
  disabled: boolean
  /** 解析成功后的回调，调用方负责把对象写回表单。 */
  onApply: (parsed: unknown) => { ok: true } | { ok: false; message: string }
  /** 可选：额外提示（例如版本不一致）。 */
  notice?: string
}

type ParseState =
  | { status: 'idle' }
  | { status: 'ok' }
  | { status: 'error'; message: string; line: number | null }

function describeParseError(error: unknown, text: string): ParseState {
  const message = error instanceof Error ? error.message : String(error)
  const positionMatch = /position (\d+)/.exec(message)
  let line: number | null = null
  if (positionMatch?.[1]) {
    const position = Number(positionMatch[1])
    line = text.slice(0, position).split('\n').length
  } else {
    const lineMatch = /line (\d+)/.exec(message)
    if (lineMatch?.[1]) {
      line = Number(lineMatch[1])
    }
  }
  return { status: 'error', message, line }
}

export function JsonView({
  value,
  disabled,
  onApply,
  notice
}: JsonViewProps): React.JSX.Element {
  const serialized = useMemo(() => JSON.stringify(value, null, 2), [value])
  const [text, setText] = useState(serialized)
  const [parseState, setParseState] = useState<ParseState>({ status: 'idle' })

  const handleApply = (): void => {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (cause) {
      setParseState(describeParseError(cause, text))
      return
    }

    const result = onApply(parsed)
    if (result.ok) {
      setParseState({ status: 'ok' })
    } else {
      setParseState({
        status: 'error',
        message: result.message,
        line: null
      })
    }
  }

  const handleReset = (): void => {
    setText(serialized)
    setParseState({ status: 'idle' })
  }

  return (
    <div className="settings-json-view">
      <p className="settings-hint">
        这是当前表单状态的序列化结果。修改后点「应用到表单」会回写表单；
        手动刷新只是丢弃未应用的修改。
      </p>
      {notice ? <p className="settings-warn">{notice}</p> : null}
      <textarea
        className="settings-code"
        spellCheck={false}
        rows={24}
        value={text}
        disabled={disabled}
        onChange={(event) => {
          setText(event.target.value)
          setParseState({ status: 'idle' })
        }}
      />
      {parseState.status === 'error' ? (
        <p className="settings-error" role="alert">
          JSON 解析失败
          {parseState.line !== null ? `（第 ${parseState.line} 行）` : ''}：
          {parseState.message}
        </p>
      ) : null}
      {parseState.status === 'ok' ? (
        <p className="settings-success">已应用到表单</p>
      ) : null}
      <div className="settings-inline-actions">
        <button
          type="button"
          disabled={disabled || parseState.status === 'error'}
          onClick={handleApply}
        >
          应用到表单
        </button>
        <button type="button" disabled={disabled} onClick={handleReset}>
          重置为表单当前值
        </button>
      </div>
    </div>
  )
}

export type ViewMode = 'form' | 'json'

export interface ViewModeSwitchProps {
  mode: ViewMode
  onChange: (mode: ViewMode) => void
  disabled?: boolean
}

/** 表单 / JSON 视图切换；默认始终是表单。 */
export function ViewModeSwitch({
  mode,
  onChange,
  disabled
}: ViewModeSwitchProps): React.JSX.Element {
  return (
    <div className="settings-view-switch" role="group" aria-label="视图模式">
      <button
        type="button"
        className={mode === 'form' ? 'is-active' : ''}
        aria-pressed={mode === 'form'}
        disabled={disabled}
        onClick={() => onChange('form')}
      >
        表单
      </button>
      <button
        type="button"
        className={mode === 'json' ? 'is-active' : ''}
        aria-pressed={mode === 'json'}
        disabled={disabled}
        onClick={() => onChange('json')}
      >
        JSON
      </button>
    </div>
  )
}
