import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  PROJECT_DOWNLOAD_RECOVERY_PROJECT_ID,
  PROJECT_DOWNLOAD_RECOVERY_STRATEGY_ID,
  createProjectDownloadRecoveryProjectDraft,
  createProjectDownloadRecoveryStrategyDraft
} from '../src/main/project-download-recovery-smoke'
import { parseProjectDraft } from '../src/main/project-store'
import { parseStrategyManifest } from '../src/main/strategy-store'

describe('project download recovery smoke templates', () => {
  const pageUrl = 'http://127.0.0.1:43123/project-download-recovery'
  const expectedBytes = 1024 * 1024

  it('creates a valid Project that resumes from the download wait checkpoint', () => {
    const draft = createProjectDownloadRecoveryProjectDraft({
      profileId: 'download-recovery-profile',
      pageUrl,
      outputRoot: join(tmpdir(), 'agentic-download-recovery-output'),
      expectedBytes
    })

    expect(parseProjectDraft(draft)).toEqual(draft)
    expect(draft).toMatchObject({
      id: PROJECT_DOWNLOAD_RECOVERY_PROJECT_ID,
      enabled: true,
      startupPages: [pageUrl],
      strategies: [{ id: PROJECT_DOWNLOAD_RECOVERY_STRATEGY_ID }],
      capabilities: { defaults: { downloads: true } }
    })
    expect(draft.workflow.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'open-download-page',
          next: 'wait-download',
          checkpoint: true
        }),
        expect.objectContaining({
          id: 'wait-download',
          eventName: 'download.completed'
        })
      ])
    )
  })

  it('creates a narrow Strategy that safely retries an interrupted intent', () => {
    const draft = createProjectDownloadRecoveryStrategyDraft(
      pageUrl,
      expectedBytes
    )

    expect(parseStrategyManifest(draft.manifest)).toEqual(draft.manifest)
    expect(draft.manifest.matches).toEqual(['http://127.0.0.1:43123/*'])
    expect(draft.manifest.permissions).toEqual([
      'dom.write',
      'project.emit-event',
      'log'
    ])
    expect(draft.source).toContain('/slow-sample.mp3')
    expect(draft.source).toContain(`expectedBytes: ${expectedBytes}`)
    expect(draft.source).toContain('reservation.canStart === true')
    expect(draft.source).toContain("reservation.kind === 'duplicate'")
  })

  it('rejects unsupported URLs and invalid byte counts', () => {
    expect(() =>
      createProjectDownloadRecoveryStrategyDraft('file:///tmp/test', 1)
    ).toThrow(/HTTP/)
    expect(() =>
      createProjectDownloadRecoveryProjectDraft({
        profileId: 'download-recovery-profile',
        pageUrl,
        outputRoot: join(tmpdir(), 'agentic-download-recovery-output'),
        expectedBytes: 0
      })
    ).toThrow(/字节数/)
  })
})
