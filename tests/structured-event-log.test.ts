import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { StructuredEventLog } from '../src/main/structured-event-log'

describe('StructuredEventLog', () => {
  let temporaryRoot: string

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'agentic-event-log-test-'))
  })

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true })
  })

  it('serializes concurrent appends as complete JSONL records', async () => {
    const path = join(temporaryRoot, 'logs', 'browser-events.jsonl')
    const log = new StructuredEventLog(path)

    await Promise.all([
      log.append({ sequence: 1, type: 'created' }),
      log.append({ sequence: 2, type: 'load-started' }),
      log.append({ sequence: 3, type: 'load-finished' })
    ])
    await log.flush()

    const records = (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { sequence: number })
    expect(records.map((record) => record.sequence)).toEqual([1, 2, 3])
  })
})
