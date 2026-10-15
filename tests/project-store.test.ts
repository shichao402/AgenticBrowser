import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createCapabilityPolicy } from '../src/main/capability-store'
import {
  ProjectStore,
  parseProjectDraft,
  parseProjectState
} from '../src/main/project-store'
import type { ProjectDraft } from '../src/shared/contracts'

describe('ProjectStore', () => {
  let temporaryRoot: string
  let filePath: string
  let store: ProjectStore

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'agentic-project-test-'))
    filePath = join(temporaryRoot, 'projects.json')
    store = new ProjectStore(filePath)
  })

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true })
  })

  it('persists a strict project schema and increments its revision', async () => {
    const first = await store.save(createDraft('project-a'))
    expect(first.activeProjectId).toBe('project-a')
    expect(first.projects[0]).toMatchObject({
      id: 'project-a',
      revision: 1,
      profileId: 'profile-a'
    })

    const updated = await store.save({
      ...createDraft('project-a'),
      name: '更新后的项目'
    })
    expect(updated.projects).toHaveLength(1)
    expect(updated.projects[0]).toMatchObject({
      name: '更新后的项目',
      revision: 2
    })
    expect(updated.projects[0]?.createdAt).toBe(
      first.projects[0]?.createdAt
    )
  })

  it('serializes concurrent saves and maintains an active project', async () => {
    await Promise.all([
      store.save(createDraft('project-a')),
      store.save(createDraft('project-b')),
      store.save(createDraft('project-c'))
    ])
    const state = await store.read()
    expect(state.projects.map((project) => project.id)).toEqual([
      'project-a',
      'project-b',
      'project-c'
    ])
    expect(state.activeProjectId).toBe('project-a')

    await store.setActive('project-c')
    const deleted = await store.delete('project-c')
    expect(deleted.activeProjectId).toBe('project-a')
  })

  it('rejects dangling workflow transitions and non-fixed strategy versions', () => {
    const draft = createDraft('invalid-project')
    expect(
      parseProjectDraft({
        ...draft,
        workflow: {
          ...draft.workflow,
          nodes: [
            {
              ...draft.workflow.nodes[0],
              next: 'missing-node'
            },
            draft.workflow.nodes[1]
          ]
        }
      })
    ).toBeNull()
    expect(
      parseProjectDraft({
        ...draft,
        strategies: [{ id: 'feed-scanner', version: 'latest' }]
      })
    ).toBeNull()
  })

  it('requires schedules only for schedule mode and accepts explicit timezones', () => {
    const draft = createDraft('scheduled-project')
    expect(
      parseProjectDraft({
        ...draft,
        runtime: {
          ...draft.runtime,
          mode: 'schedule',
          timezone: 'Asia/Shanghai',
          schedule: { kind: 'daily', times: ['08:30', '20:15'] }
        }
      })
    ).not.toBeNull()
    expect(
      parseProjectDraft({
        ...draft,
        runtime: {
          ...draft.runtime,
          mode: 'manual',
          schedule: { kind: 'interval', everyMinutes: 5 }
        }
      })
    ).toBeNull()
  })

  it('quarantines an invalid persisted registry instead of boot-looping', async () => {
    await writeFile(filePath, '{"schemaVersion":1,"projects":[}', 'utf8')
    await expect(store.read()).resolves.toEqual({
      schemaVersion: 1,
      activeProjectId: null,
      projects: []
    })
    const files = await readdir(temporaryRoot)
    expect(files.some((file) => file.startsWith('projects.json.invalid-'))).toBe(
      true
    )
  })

  it('rejects unknown fields in persisted state', () => {
    expect(
      parseProjectState({
        schemaVersion: 1,
        activeProjectId: null,
        projects: [],
        ignored: true
      })
    ).toBeNull()
  })
})

function createDraft(id: string): ProjectDraft {
  return {
    id,
    name: `Project ${id}`,
    profileId: `profile-${id.slice(-1)}`,
    startupPages: ['https://example.com/feed'],
    strategies: [
      { id: 'feed-scanner', version: '0.1.0' },
      { id: 'audio-downloader', version: '0.1.0' }
    ],
    runtime: {
      mode: 'manual',
      timezone: 'Asia/Shanghai',
      priority: 0,
      maxRunMs: 60_000
    },
    workflow: {
      version: 1,
      entryNodeId: 'open-feed',
      nodes: [
        {
          id: 'open-feed',
          kind: 'navigate',
          url: 'https://example.com/feed',
          next: 'finished',
          timeoutMs: 10_000,
          maxAttempts: 3,
          checkpoint: true,
          onFailure: { network: 'open-feed' }
        },
        {
          id: 'finished',
          kind: 'complete',
          timeoutMs: 1_000,
          maxAttempts: 1,
          checkpoint: true
        }
      ]
    },
    output: {
      root: join(tmpdir(), id),
      maxBytes: 1024 * 1024 * 1024,
      fileNameTemplate: '{postId}-{fileName}'
    },
    capabilities: createCapabilityPolicy(),
    filter: {
      enabled: true,
      networkRules: [
        {
          id: 'block-images',
          action: 'block',
          urlPattern: 'https://ads.example.com/*',
          resourceTypes: ['image']
        }
      ],
      cssRules: [
        {
          id: 'hide-overlay',
          urlPattern: 'https://example.com/*',
          selectors: ['.marketing-overlay']
        }
      ]
    },
    retry: {
      maxConsecutiveFailures: 5,
      baseBackoffMs: 1_000,
      maxBackoffMs: 60_000
    },
    enabled: true
  }
}
