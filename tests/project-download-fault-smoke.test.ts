import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  PROJECT_DOWNLOAD_DISK_PROJECT_ID,
  PROJECT_DOWNLOAD_DISK_STRATEGY_ID,
  PROJECT_DOWNLOAD_NETWORK_PROJECT_ID,
  PROJECT_DOWNLOAD_NETWORK_STRATEGY_ID,
  createProjectDownloadFaultProjectDraft,
  createProjectDownloadFaultStrategyDraft
} from '../src/main/project-download-fault-smoke'
import { parseProjectDraft } from '../src/main/project-store'
import { parseStrategyManifest } from '../src/main/strategy-store'

describe('project download fault smoke templates', () => {
  const networkUrl = 'http://127.0.0.1:43123/network-page'
  const diskUrl = 'http://127.0.0.1:43123/disk-page'

  it('creates a network-failure workflow and narrow Strategy', () => {
    const strategy = createProjectDownloadFaultStrategyDraft(
      'network',
      networkUrl,
      1024 * 1024
    )
    const project = createProjectDownloadFaultProjectDraft('network', {
      profileId: 'download-fault-profile',
      pageUrl: networkUrl,
      outputRoot: join(tmpdir(), 'agentic-download-network-output'),
      expectedBytes: 1024 * 1024
    })

    expect(parseStrategyManifest(strategy.manifest)).toEqual(strategy.manifest)
    expect(parseProjectDraft(project)).toEqual(project)
    expect(strategy.manifest.id).toBe(PROJECT_DOWNLOAD_NETWORK_STRATEGY_ID)
    expect(strategy.source).toContain('/slow-network.mp3')
    expect(project).toMatchObject({
      id: PROJECT_DOWNLOAD_NETWORK_PROJECT_ID,
      strategies: [{ id: PROJECT_DOWNLOAD_NETWORK_STRATEGY_ID }]
    })
    expect(project.workflow.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'wait-download-failed',
          eventName: 'download.failed'
        })
      ])
    )
  })

  it('creates a disk preflight rejection with no download fallback', () => {
    const expectedBytes = 2 * 1024 * 1024
    const strategy = createProjectDownloadFaultStrategyDraft(
      'disk',
      diskUrl,
      expectedBytes
    )
    const project = createProjectDownloadFaultProjectDraft('disk', {
      profileId: 'download-fault-profile',
      pageUrl: diskUrl,
      outputRoot: join(tmpdir(), 'agentic-download-disk-output'),
      expectedBytes
    })

    expect(parseStrategyManifest(strategy.manifest)).toEqual(strategy.manifest)
    expect(parseProjectDraft(project)).toEqual(project)
    expect(strategy.manifest.id).toBe(PROJECT_DOWNLOAD_DISK_STRATEGY_ID)
    expect(strategy.source).toContain('/disk-sample.mp3')
    expect(project).toMatchObject({
      id: PROJECT_DOWNLOAD_DISK_PROJECT_ID,
      output: { maxBytes: 1024 * 1024 },
      strategies: [{ id: PROJECT_DOWNLOAD_DISK_STRATEGY_ID }]
    })
    expect(project.output.maxBytes).toBeLessThan(expectedBytes)
  })

  it('rejects unsupported URLs and invalid byte counts', () => {
    expect(() =>
      createProjectDownloadFaultStrategyDraft(
        'network',
        'file:///tmp/network',
        1
      )
    ).toThrow(/HTTP/)
    expect(() =>
      createProjectDownloadFaultProjectDraft('disk', {
        profileId: 'download-fault-profile',
        pageUrl: diskUrl,
        outputRoot: join(tmpdir(), 'agentic-download-disk-output'),
        expectedBytes: 0
      })
    ).toThrow(/字节数/)
  })
})
