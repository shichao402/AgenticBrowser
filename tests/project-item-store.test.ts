import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  parseProjectItemObservation,
  parseProjectItemState,
  ProjectItemStore
} from '../src/main/project-item-store'

describe('ProjectItemStore', () => {
  let temporaryRoot: string
  let now: number
  let filePath: string
  let store: ProjectItemStore

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'agentic-item-test-'))
    filePath = join(temporaryRoot, 'records', 'items.json')
    now = Date.parse('2026-10-15T00:00:00.000Z')
    store = new ProjectItemStore(filePath, { now: () => now })
  })

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true })
  })

  it('persists observations and counts an item once per runtime', async () => {
    const first = await store.observe(
      'knowledge-audio',
      observation('matched'),
      'https://wx.zsxq.com/dweb2/index/group/123',
      'runtime-abcdefgh'
    )
    expect(first).toMatchObject({
      kind: 'created',
      firstSeenInRuntime: true,
      record: {
        projectId: 'knowledge-audio',
        businessItemId: 'topic-42',
        classification: 'matched',
        seenCount: 1
      }
    })

    now += 1_000
    const duplicate = await store.observe(
      'knowledge-audio',
      observation('matched'),
      'https://wx.zsxq.com/dweb2/index/group/123',
      'runtime-abcdefgh'
    )
    expect(duplicate).toMatchObject({
      kind: 'updated',
      firstSeenInRuntime: false,
      record: { seenCount: 1 }
    })

    now += 1_000
    const nextRun = await store.observe(
      'knowledge-audio',
      {
        ...observation('skipped'),
        text: '复核后不匹配'
      },
      'https://wx.zsxq.com/dweb2/index/group/123',
      'runtime-ijklmnop'
    )
    expect(nextRun).toMatchObject({
      kind: 'updated',
      firstSeenInRuntime: true,
      record: {
        runtimeId: 'runtime-ijklmnop',
        lastRuntimeId: 'runtime-ijklmnop',
        classification: 'skipped',
        text: '复核后不匹配',
        seenCount: 2
      }
    })
    await expect(store.read()).resolves.toMatchObject({
      schemaVersion: 1,
      records: [{ businessItemId: 'topic-42', seenCount: 2 }]
    })
  })

  it('rejects malformed observations and persisted duplicate keys', () => {
    expect(
      parseProjectItemObservation(
        {
          businessItemId: 'topic-42',
          text: '会议语音',
          classification: 'unknown',
          attachmentCount: 1
        },
        'https://wx.zsxq.com/dweb',
        'runtime-abcdefgh'
      )
    ).toBeNull()

    const record = {
      runtimeId: 'runtime-abcdefgh',
      sourceUrl: 'https://wx.zsxq.com/dweb',
      businessItemId: 'topic-42',
      text: '会议语音',
      classification: 'matched',
      attachmentCount: 1,
      publishedAt: null,
      metadata: {},
      projectId: 'knowledge-audio',
      firstSeenAt: '2026-10-15T00:00:00.000Z',
      lastSeenAt: '2026-10-15T00:00:00.000Z',
      lastRuntimeId: 'runtime-abcdefgh',
      seenCount: 1
    }
    expect(
      parseProjectItemState({
        schemaVersion: 1,
        records: [record, record]
      })
    ).toBeNull()
  })

  it('quarantines an invalid records file', async () => {
    await mkdir(join(temporaryRoot, 'records'), { recursive: true })
    await writeFile(filePath, '{"schemaVersion":1,"records":"bad"}')

    await expect(store.read()).resolves.toEqual({
      schemaVersion: 1,
      records: []
    })
    expect(
      (await readdir(join(temporaryRoot, 'records'))).some((name) =>
        name.startsWith('items.json.invalid-')
      )
    ).toBe(true)
  })
})

function observation(classification: 'matched' | 'skipped') {
  return {
    businessItemId: 'topic-42',
    sourceUrl: 'https://wx.zsxq.com/dweb2/index/topic_detail/42',
    text: '会议语音',
    classification,
    attachmentCount: 1,
    publishedAt: '2026-10-15T08:00:00.000Z',
    metadata: { groupId: '123' }
  }
}
