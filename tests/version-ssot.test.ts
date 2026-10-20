import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

describe('VERSION.json single source of truth', () => {
  it('matches package metadata', () => {
    execFileSync(process.execPath, ['scripts/version-ssot.mjs', 'check'], {
      stdio: 'pipe'
    })
  })

  it('prints the declared version', () => {
    const declared = JSON.parse(readFileSync('VERSION.json', 'utf8'))
      .version as string
    const printed = execFileSync(
      process.execPath,
      ['scripts/version-ssot.mjs', 'print'],
      {
        encoding: 'utf8'
      }
    ).trim()

    expect(printed).toBe(declared)
  })
})
