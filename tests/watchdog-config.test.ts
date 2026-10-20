import { describe, expect, it } from 'vitest'

import { parseWatchdogConfig } from '../src/main/watchdog-config'

/**
 * 这些数值直接决定守护行为：`heartbeatTimeoutMs` 太小会误判卡死并频繁重启，
 * `maxRestarts` 太大则可能在崩溃循环里无限重启。因此每条边界都值得锁住。
 */

const validConfig = {
  schemaVersion: 1,
  command: 'electron',
  args: ['.'],
  cwd: '/tmp/app',
  env: { NODE_ENV: 'production' },
  heartbeatPath: '/tmp/heartbeat.json',
  statePath: '/tmp/state.json',
  maxRestarts: 3,
  startupGraceMs: 5_000,
  heartbeatTimeoutMs: 10_000,
  heartbeatPollMs: 500,
  restartBackoffMs: 1_000
}

describe('parseWatchdogConfig', () => {
  it('returns the normalised config', () => {
    expect(parseWatchdogConfig(validConfig)).toEqual(validConfig)
  })

  it('defaults env to an empty record when omitted', () => {
    const { env: _omitted, ...withoutEnv } = validConfig
    expect(parseWatchdogConfig(withoutEnv).env).toEqual({})
  })

  it('omits lockPath entirely when not supplied', () => {
    const config = parseWatchdogConfig(validConfig)
    expect(config).not.toHaveProperty('lockPath')
  })

  it('keeps lockPath when supplied', () => {
    expect(
      parseWatchdogConfig({ ...validConfig, lockPath: '/tmp/lock' }).lockPath
    ).toBe('/tmp/lock')
  })

  it.each([null, undefined, 'string', 42, [], {}])(
    'rejects a non-config payload %p',
    (value) => {
      expect(() => parseWatchdogConfig(value)).toThrow('版本无效')
    }
  )

  it('rejects an unsupported schema version', () => {
    expect(() =>
      parseWatchdogConfig({ ...validConfig, schemaVersion: 2 })
    ).toThrow('版本无效')
  })

  it.each(['command', 'cwd', 'heartbeatPath', 'statePath'])(
    'rejects a blank %s',
    (key) => {
      expect(() => parseWatchdogConfig({ ...validConfig, [key]: '' })).toThrow(
        `${key} 必须是非空字符串`
      )
      expect(() =>
        parseWatchdogConfig({ ...validConfig, [key]: '   ' })
      ).toThrow(`${key} 必须是非空字符串`)
      expect(() => parseWatchdogConfig({ ...validConfig, [key]: 123 })).toThrow(
        `${key} 必须是非空字符串`
      )
    }
  )

  it('rejects a non-string lockPath', () => {
    expect(() => parseWatchdogConfig({ ...validConfig, lockPath: 42 })).toThrow(
      'lockPath 必须是非空字符串'
    )
  })

  it('rejects args that are not a string array', () => {
    expect(() =>
      parseWatchdogConfig({ ...validConfig, args: 'electron .' })
    ).toThrow('args 必须是字符串数组')
    expect(() =>
      parseWatchdogConfig({ ...validConfig, args: ['.', 1] })
    ).toThrow('args 必须是字符串数组')
  })

  it('accepts an empty args array', () => {
    expect(parseWatchdogConfig({ ...validConfig, args: [] }).args).toEqual([])
  })

  it('rejects env values that are not strings', () => {
    expect(() =>
      parseWatchdogConfig({ ...validConfig, env: { PORT: 3000 } })
    ).toThrow('env 必须是字符串字典')
    expect(() => parseWatchdogConfig({ ...validConfig, env: ['a'] })).toThrow(
      'env 必须是字符串字典'
    )
  })

  // 每条数值都验证「下限-1 / 下限 / 上限 / 上限+1」四个点，避免只测一侧导致
  // 边界写反也发现不了。
  const integerFields: Array<[string, number, number, number]> = [
    ['maxRestarts', 3, 0, 20],
    ['startupGraceMs', 5_000, 100, 120_000],
    ['heartbeatTimeoutMs', 10_000, 100, 120_000],
    ['heartbeatPollMs', 500, 50, 10_000],
    ['restartBackoffMs', 1_000, 0, 120_000]
  ]

  it.each(integerFields)(
    'enforces the %s range [%i, %i]',
    (field, _current, minimum, maximum) => {
      expect(
        parseWatchdogConfig({ ...validConfig, [field]: minimum })[
          field as keyof typeof validConfig
        ]
      ).toBe(minimum)
      expect(
        parseWatchdogConfig({ ...validConfig, [field]: maximum })[
          field as keyof typeof validConfig
        ]
      ).toBe(maximum)

      expect(() =>
        parseWatchdogConfig({ ...validConfig, [field]: minimum - 1 })
      ).toThrow(`${field} 必须是 ${minimum}–${maximum} 的整数`)
      expect(() =>
        parseWatchdogConfig({ ...validConfig, [field]: maximum + 1 })
      ).toThrow(`${field} 必须是 ${minimum}–${maximum} 的整数`)
    }
  )

  it.each([
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['string', '1000'],
    ['null', null]
  ])('rejects a %s value where an integer is required', (_label, value) => {
    expect(() =>
      parseWatchdogConfig({ ...validConfig, maxRestarts: value })
    ).toThrow('maxRestarts 必须是 0–20 的整数')
  })
})
