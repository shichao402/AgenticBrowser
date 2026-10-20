import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ProjectDownloadManager,
  createDownloadIdempotencyKey
} from '../src/main/project-download-manager'
import { ProjectRuntimeStore } from '../src/main/project-runtime-store'
import type { ProjectDefinition } from '../src/shared/contracts'
import { createProjectDefinition } from './project-fixture'

describe('ProjectDownloadManager', () => {
  let temporaryRoot: string
  let project: ProjectDefinition
  let sequence: number
  let runtimeStore: ProjectRuntimeStore
  let manager: ProjectDownloadManager

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'agentic-download-test-'))
    project = {
      ...createProjectDefinition([]),
      id: 'download-project',
      output: {
        root: temporaryRoot,
        maxBytes: 1024 * 1024,
        fileNameTemplate: '{postId}-{fileName}'
      }
    }
    sequence = 0
    runtimeStore = new ProjectRuntimeStore(
      join(temporaryRoot, 'records', 'runtimes.json')
    )
    manager = new ProjectDownloadManager(
      join(temporaryRoot, 'records', 'downloads.json'),
      {
        minimumFreeBytes: 0,
        createId: () => `downloadid${++sequence}`,
        runtimeStore,
        getAvailableBytes: async () => 1024 * 1024 * 1024
      }
    )
  })

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true })
  })

  it('commits a temporary file atomically with metadata and idempotency', async () => {
    const reservation = await manager.reserve(project, intent())
    expect(reservation.kind).toBe('reserved')
    if (reservation.kind !== 'reserved') {
      throw new Error('expected reservation')
    }
    await writeFile(reservation.record.temporaryPath, Buffer.from('mp3-data'))
    await manager.markDownloading(reservation.record.downloadId)
    const completed = await manager.complete(reservation.record.downloadId)

    expect(completed).toMatchObject({
      status: 'completed',
      safeFileName: 'post-1-meeting.mp3',
      size: 8,
      mime: 'audio/mpeg'
    })
    expect(completed.sha256).toMatch(/^[a-f0-9]{64}$/)
    await expect(readFile(completed.finalPath, 'utf8')).resolves.toBe(
      'mp3-data'
    )
    await expect(access(completed.temporaryPath)).rejects.toThrow()
    await expect(
      runtimeStore.findIdempotency(project.id, completed.idempotencyKey)
    ).resolves.toMatchObject({
      result: {
        finalPath: completed.finalPath,
        sha256: completed.sha256
      }
    })
  })

  it('returns the completed record for duplicate business attachments', async () => {
    const first = await manager.reserve(project, intent())
    if (first.kind !== 'reserved') {
      throw new Error('expected reservation')
    }
    await writeFile(first.record.temporaryPath, 'same')
    const completed = await manager.complete(first.record.downloadId)

    const duplicate = await manager.reserve(project, intent())
    expect(duplicate).toEqual({
      kind: 'duplicate',
      record: completed
    })
    expect((await manager.read()).records).toHaveLength(1)
  })

  it('increments runtime download counters exactly once', async () => {
    const runtime = await runtimeStore.create(project, 'manual')
    const reservation = await manager.reserve(project, {
      ...intent(),
      runtimeId: runtime.runtime.runtimeId
    })
    if (reservation.kind !== 'reserved') {
      throw new Error('expected reservation')
    }
    await writeFile(reservation.record.temporaryPath, 'mp3-data')
    await manager.complete(reservation.record.downloadId)
    await manager.complete(reservation.record.downloadId)

    const updated = (await runtimeStore.read()).runtimes.find(
      ({ runtime: candidate }) =>
        candidate.runtimeId === runtime.runtime.runtimeId
    )
    expect(updated?.runtime.counters).toMatchObject({
      downloaded: 1,
      downloadedBytes: 8
    })
  })

  it('increments the runtime failure counter once per failed record', async () => {
    const runtime = await runtimeStore.create(project, 'manual')
    const reservation = await manager.reserve(project, {
      ...intent(),
      runtimeId: runtime.runtime.runtimeId
    })
    if (reservation.kind !== 'reserved') {
      throw new Error('expected reservation')
    }
    await manager.markDownloading(reservation.record.downloadId)
    await manager.fail(
      reservation.record.downloadId,
      'network',
      'diagnostic-offline'
    )
    await manager.fail(
      reservation.record.downloadId,
      'network',
      'diagnostic-offline'
    )

    const updated = (await runtimeStore.read()).runtimes.find(
      ({ runtime: candidate }) =>
        candidate.runtimeId === runtime.runtime.runtimeId
    )
    expect(updated?.runtime.counters.failed).toBe(1)
    expect((await manager.read()).records[0]).toMatchObject({
      status: 'failed',
      errorCategory: 'network',
      retryCount: 1
    })
  })

  it('does not reserve the same attachment twice while it is in progress', async () => {
    const first = await manager.reserve(project, intent())
    if (first.kind !== 'reserved') {
      throw new Error('expected reservation')
    }

    await expect(manager.reserve(project, intent())).resolves.toEqual({
      kind: 'in-progress',
      record: first.record
    })
    expect((await manager.read()).records).toHaveLength(1)
  })

  it('allocates deterministic suffixes without overwriting another attachment', async () => {
    const [first, second] = await Promise.all([
      manager.reserve(project, intent()),
      manager.reserve(project, {
        ...intent(),
        attachmentId: 'attachment-2'
      })
    ])
    expect(first.kind).toBe('reserved')
    expect(second.kind).toBe('reserved')
    if (first.kind === 'reserved' && second.kind === 'reserved') {
      expect(
        [first.record.safeFileName, second.record.safeFileName].sort()
      ).toEqual(['post-1-meeting (2).mp3', 'post-1-meeting.mp3'])
    }
  })

  it('fails before starting when disk reserve or project quota is insufficient', async () => {
    const lowDisk = new ProjectDownloadManager(
      join(temporaryRoot, 'records', 'low-disk.json'),
      {
        minimumFreeBytes: 100,
        getAvailableBytes: async () => 50
      }
    )
    await expect(lowDisk.reserve(project, intent())).resolves.toMatchObject({
      kind: 'rejected',
      record: {
        status: 'failed',
        errorCategory: 'disk',
        retryCount: 1
      }
    })

    await expect(
      manager.reserve(
        {
          ...project,
          output: { ...project.output, maxBytes: 1024 * 1024 }
        },
        { ...intent(), expectedBytes: 1024 * 1024 + 1 }
      )
    ).resolves.toMatchObject({
      kind: 'rejected',
      record: {
        status: 'failed',
        errorCategory: 'disk',
        error: expect.stringContaining('配额')
      }
    })
  })

  it('keeps disk rejections auditable and reuses their filename on retry', async () => {
    let availableBytes = 0
    const retrying = new ProjectDownloadManager(
      join(temporaryRoot, 'records', 'disk-retry.json'),
      {
        minimumFreeBytes: 100,
        createId: () => `diskretry${++sequence}`,
        getAvailableBytes: async () => availableBytes
      }
    )
    const rejected = await retrying.reserve(project, intent())
    expect(rejected.kind).toBe('rejected')
    if (rejected.kind !== 'rejected') {
      throw new Error('expected rejected reservation')
    }
    await expect(retrying.reserve(project, intent())).resolves.toEqual({
      kind: 'rejected',
      record: rejected.record,
      newlyCreated: false
    })
    expect((await retrying.read()).records).toHaveLength(1)

    availableBytes = 1024 * 1024 * 1024
    const retry = await retrying.reserve(project, {
      ...intent(),
      runtimeId: 'runtime-download2'
    })
    expect(retry.kind).toBe('reserved')
    if (retry.kind !== 'reserved') {
      throw new Error('expected retry reservation')
    }
    expect(retry.record).toMatchObject({
      safeFileName: rejected.record.safeFileName,
      finalPath: rejected.record.finalPath,
      retryCount: 1
    })
    expect((await retrying.read()).records).toEqual([
      expect.objectContaining({
        status: 'failed',
        errorCategory: 'disk'
      }),
      expect.objectContaining({ status: 'reserved' })
    ])
  })

  it('classifies interrupted downloads and preserves their temporary evidence', async () => {
    const reservation = await manager.reserve(project, intent())
    if (reservation.kind !== 'reserved') {
      throw new Error('expected reservation')
    }
    await writeFile(reservation.record.temporaryPath, 'partial')
    await manager.markDownloading(reservation.record.downloadId)

    const recovered = await manager.recoverInterrupted()
    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({
      status: 'failed',
      errorCategory: 'unknown'
    })
    await expect(
      readFile(reservation.record.temporaryPath, 'utf8')
    ).resolves.toBe('partial')
  })

  it('safely retries an interrupted attachment without adding a filename suffix', async () => {
    const first = await manager.reserve(project, intent())
    if (first.kind !== 'reserved') {
      throw new Error('expected reservation')
    }
    await writeFile(first.record.temporaryPath, 'partial')
    await manager.markDownloading(first.record.downloadId)
    await manager.recoverInterrupted()

    const retry = await manager.reserve(project, intent())
    expect(retry.kind).toBe('reserved')
    if (retry.kind !== 'reserved') {
      throw new Error('expected retry reservation')
    }
    expect(retry.record).toMatchObject({
      safeFileName: first.record.safeFileName,
      finalPath: first.record.finalPath,
      retryCount: 1
    })
    await writeFile(retry.record.temporaryPath, 'mp3-data')
    await manager.markDownloading(retry.record.downloadId)
    const completed = await manager.complete(retry.record.downloadId)

    expect(completed).toMatchObject({
      status: 'completed',
      safeFileName: 'post-1-meeting.mp3',
      size: 8
    })
    await expect(readFile(completed.finalPath, 'utf8')).resolves.toBe(
      'mp3-data'
    )
    await expect(readFile(first.record.temporaryPath, 'utf8')).resolves.toBe(
      'partial'
    )
  })

  it('bounds long idempotency inputs with a stable digest', () => {
    const key = createDownloadIdempotencyKey(project.id, {
      businessItemId: 'post'.repeat(200),
      attachmentId: 'attachment'.repeat(100),
      sourceUrl: 'https://example.com/file.mp3'
    })
    expect(key.length).toBeLessThanOrEqual(500)
    expect(key).toMatch(/^download-project:sha256:[a-f0-9]{64}$/)
  })
})

function intent() {
  return {
    runtimeId: 'runtime-download1',
    workflowNodeId: 'download',
    sourcePage: 'https://example.com/post/1',
    sourceUrl: 'https://cdn.example.com/meeting.mp3',
    businessItemId: 'post-1',
    attachmentId: 'attachment-1',
    originalFileName: 'meeting.mp3',
    mime: 'audio/mpeg',
    expectedBytes: 8
  }
}
