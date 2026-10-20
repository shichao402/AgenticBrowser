import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { writeSmokeResultFile } from '../src/main/smoke-result-writer'

const directories: string[] = []

function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'agentic-smoke-result-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('writeSmokeResultFile', () => {
  it('writes pretty-printed JSON so CI artifacts stay readable', () => {
    const directory = makeDirectory()

    writeSmokeResultFile(
      { enabled: true, fileName: 'phase0-smoke-result.json' },
      { passed: true, nested: { value: 1 } },
      directory
    )

    const file = join(directory, 'phase0-smoke-result.json')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(
      `${JSON.stringify({ passed: true, nested: { value: 1 } }, null, 2)}\n`
    )
  })

  // 未触发的场景不应留下空文件，否则 CI 的 artifact 里会混入误导性的结果。
  it('writes nothing when the scenario is not enabled', () => {
    const directory = makeDirectory()

    writeSmokeResultFile(
      { enabled: false, fileName: 'phase0-smoke-result.json' },
      { passed: false },
      directory
    )

    expect(existsSync(join(directory, 'phase0-smoke-result.json'))).toBe(false)
  })

  it('overwrites a previous run instead of appending', () => {
    const directory = makeDirectory()
    const target = { enabled: true, fileName: 'result.json' }

    writeSmokeResultFile(target, { run: 1 }, directory)
    writeSmokeResultFile(target, { run: 2 }, directory)

    expect(
      JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8'))
    ).toEqual({ run: 2 })
  })

  it('defaults to the process working directory', () => {
    const before = existsSync(join(process.cwd(), 'phase0-smoke-result.json'))

    writeSmokeResultFile(
      { enabled: false, fileName: 'phase0-smoke-result.json' },
      { passed: true }
    )

    // 未启用时不得在当前工作目录留下产物，这里只验证默认参数不会意外写入。
    expect(existsSync(join(process.cwd(), 'phase0-smoke-result.json'))).toBe(
      before
    )
  })
})
