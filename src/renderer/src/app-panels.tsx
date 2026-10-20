import type {
  BrowserEvent,
  CapabilityPolicySnapshot,
  CapabilitySettings
} from '../../shared/contracts'
import { CAPABILITY_ITEMS, EVENT_LABELS, getOriginDecision } from './app-format'

export interface CapabilityPanelProps {
  capabilityPolicy: CapabilityPolicySnapshot | null
  locked: boolean
  onToggleDefault(key: keyof CapabilitySettings): void
  onSetOrigin(
    key: keyof CapabilitySettings,
    decision: 'inherit' | 'allow' | 'deny'
  ): void
}

/**
 * 能力中心面板。
 *
 * `locked` 对应"已有项目运行活跃"，此时禁止修改默认策略与 Origin 覆盖，
 * 避免运行中的项目在使用策略时被中途改掉。
 */
export function CapabilityPanel({
  capabilityPolicy,
  locked,
  onToggleDefault,
  onSetOrigin
}: CapabilityPanelProps): React.JSX.Element {
  return (
    <section className="capability-panel">
      <div className="panel-heading">
        <h2>能力中心</h2>
        <span>{capabilityPolicy?.currentOrigin ?? '非 HTTP(S) 页面'}</span>
      </div>
      <p className="capability-help">
        默认策略可被当前精确 Origin 覆盖；子域不会继承。
      </p>
      <div className="capability-list">
        {CAPABILITY_ITEMS.map((item) => {
          const decision = getOriginDecision(capabilityPolicy, item.key)
          const effective = capabilityPolicy?.effective[item.key] ?? false
          return (
            <div className="capability-rule" key={item.key}>
              <span>
                {item.label}
                <small>{effective ? '当前允许' : '当前拒绝'}</small>
              </span>
              <label title={`${item.label}的默认策略`}>
                <input
                  type="checkbox"
                  checked={capabilityPolicy?.policy.defaults[item.key] ?? false}
                  disabled={!capabilityPolicy || locked}
                  onChange={() => onToggleDefault(item.key)}
                />
                默认
              </label>
              <select
                aria-label={`${item.label}的当前 Origin 策略`}
                value={decision}
                disabled={!capabilityPolicy?.currentOrigin || locked}
                onChange={(event) =>
                  onSetOrigin(
                    item.key,
                    event.target.value as 'inherit' | 'allow' | 'deny'
                  )
                }
              >
                <option value="inherit">继承</option>
                <option value="allow">允许</option>
                <option value="deny">拒绝</option>
              </select>
            </div>
          )
        })}
      </div>
    </section>
  )
}

export interface EventPanelProps {
  events: BrowserEvent[]
}

/** 生命周期事件流。仅做展示，不持有状态。 */
export function EventPanel({ events }: EventPanelProps): React.JSX.Element {
  return (
    <section className="event-panel">
      <div className="panel-heading">
        <h2>生命周期事件</h2>
        <span>{events.length}</span>
      </div>

      <ol className="event-list">
        {events.length === 0 ? (
          <li className="event-empty">等待浏览器事件</li>
        ) : (
          events.map((event) => (
            <li key={event.sequence}>
              <div>
                <strong>{EVENT_LABELS[event.type]}</strong>
                <time>{new Date(event.timestamp).toLocaleTimeString()}</time>
              </div>
              {event.detail ? <p>{event.detail}</p> : null}
            </li>
          ))
        )}
      </ol>
    </section>
  )
}
