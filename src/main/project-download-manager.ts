import { createHash, randomUUID } from 'node:crypto'
import {
  constants,
  createReadStream
} from 'node:fs'
import {
  access,
  copyFile,
  link,
  mkdir,
  rename,
  rm,
  stat,
  statfs
} from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path'

import type {
  ProjectDefinition,
  ProjectDownloadRecord,
  WorkflowFailureCategory
} from '../shared/contracts'
import {
  isNodeError,
  readJsonFile,
  writeJsonAtomic
} from './atomic-file'
import { sanitizeDownloadFileName } from './download-path'
import type { ProjectRuntimeStore } from './project-runtime-store'

export interface ProjectDownloadState {
  schemaVersion: 1
  records: ProjectDownloadRecord[]
}

export interface ProjectDownloadIntent {
  runtimeId: string
  workflowNodeId: string
  sourcePage: string
  sourceUrl: string
  businessItemId: string
  attachmentId: string
  originalFileName: string
  mime?: string
  expectedBytes?: number
}

export type ProjectDownloadReservation =
  | {
      kind: 'reserved'
      record: ProjectDownloadRecord
    }
  | {
      kind: 'in-progress'
      record: ProjectDownloadRecord
    }
  | {
      kind: 'duplicate'
      record: ProjectDownloadRecord
    }

export interface ProjectDownloadManagerOptions {
  minimumFreeBytes?: number
  now?: () => number
  createId?: () => string
  runtimeStore?: ProjectRuntimeStore
  getAvailableBytes?: (path: string) => Promise<number>
}

export class ProjectDownloadManager {
  private queue = Promise.resolve()
  private readonly now: () => number
  private readonly createId: () => string
  private readonly minimumFreeBytes: number
  private readonly getAvailableBytes: (path: string) => Promise<number>

  constructor(
    readonly filePath: string,
    private readonly options: ProjectDownloadManagerOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
    this.minimumFreeBytes = options.minimumFreeBytes ?? 50 * 1024 * 1024
    this.getAvailableBytes =
      options.getAvailableBytes ?? defaultAvailableBytes
  }

  async read(): Promise<ProjectDownloadState> {
    let value: unknown | null
    try {
      value = await readJsonFile(this.filePath)
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error
      }
      await this.quarantineInvalidFile()
      return emptyDownloadState()
    }
    if (value === null) {
      return emptyDownloadState()
    }
    const state = parseProjectDownloadState(value)
    if (state) {
      return state
    }
    await this.quarantineInvalidFile()
    return emptyDownloadState()
  }

  async reserve(
    project: ProjectDefinition,
    intent: ProjectDownloadIntent
  ): Promise<ProjectDownloadReservation> {
    validateIntent(intent)
    const root = project.output.root
    const downloadsRoot = join(root, 'downloads')
    const temporaryRoot = join(root, 'tmp')
    await Promise.all([
      mkdir(downloadsRoot, { recursive: true }),
      mkdir(temporaryRoot, { recursive: true }),
      mkdir(dirname(this.filePath), { recursive: true })
    ])
    const expectedBytes = intent.expectedBytes ?? 0
    const available = await this.getAvailableBytes(root)
    if (available - expectedBytes < this.minimumFreeBytes) {
      throw new ProjectDownloadError(
        'disk',
        `磁盘可用空间不足：${available} bytes`
      )
    }

    return this.update<ProjectDownloadReservation>(async (state) => {
      const idempotencyKey = createDownloadIdempotencyKey(
        project.id,
        intent
      )
      const duplicate = state.records.find(
        (record) =>
          record.projectId === project.id &&
          record.idempotencyKey === idempotencyKey &&
          record.status === 'completed'
      )
      if (duplicate) {
        await this.backfillIdempotency(duplicate)
        return {
          state,
          result: {
            kind: 'duplicate',
            record: structuredClone(duplicate)
          }
        }
      }
      const inProgress = state.records.find(
        (record) =>
          record.projectId === project.id &&
          record.idempotencyKey === idempotencyKey &&
          (record.status === 'reserved' ||
            record.status === 'downloading')
      )
      if (inProgress) {
        return {
          state,
          result: {
            kind: 'in-progress',
            record: structuredClone(inProgress)
          }
        }
      }

      const consumed = state.records
        .filter(
          (record) =>
            record.projectId === project.id &&
            record.status === 'completed'
        )
        .reduce((total, record) => total + record.size, 0)
      if (consumed + expectedBytes > project.output.maxBytes) {
        throw new ProjectDownloadError(
          'disk',
          `项目下载配额不足：${consumed + expectedBytes}/${project.output.maxBytes}`
        )
      }

      const safeFileName = await chooseSafeFileName(
        downloadsRoot,
        renderFileName(project.output.fileNameTemplate, intent),
        state.records
      )
      const downloadId = createDownloadId(this.createId)
      const now = new Date(this.now()).toISOString()
      const record: ProjectDownloadRecord = {
        downloadId,
        idempotencyKey,
        projectId: project.id,
        runtimeId: intent.runtimeId,
        workflowNodeId: intent.workflowNodeId,
        sourcePage: normalizeHttpUrl(intent.sourcePage),
        sourceUrl: normalizeHttpUrl(intent.sourceUrl),
        businessItemId: intent.businessItemId,
        attachmentId: intent.attachmentId,
        originalFileName: intent.originalFileName,
        safeFileName,
        temporaryPath: ensureInside(
          temporaryRoot,
          join(temporaryRoot, `${downloadId}.part`)
        ),
        finalPath: ensureInside(
          downloadsRoot,
          join(downloadsRoot, safeFileName)
        ),
        mime: intent.mime ?? null,
        size: 0,
        sha256: null,
        status: 'reserved',
        retryCount: state.records.filter(
          (candidate) =>
            candidate.projectId === project.id &&
            candidate.idempotencyKey === idempotencyKey
        ).length,
        errorCategory: null,
        error: null,
        startedAt: now,
        updatedAt: now,
        completedAt: null
      }
      return {
        state: {
          schemaVersion: 1,
          records: pruneRecords([...state.records, record])
        },
        result: { kind: 'reserved', record }
      }
    })
  }

  async markDownloading(downloadId: string): Promise<ProjectDownloadRecord> {
    return this.setStatus(downloadId, 'downloading')
  }

  async complete(downloadId: string): Promise<ProjectDownloadRecord> {
    return this.enqueue(async () => {
      const state = await this.read()
      const record = requireRecord(state, downloadId)
      if (record.status === 'completed') {
        return structuredClone(record)
      }
      if (
        record.status !== 'reserved' &&
        record.status !== 'downloading' &&
        record.status !== 'failed'
      ) {
        throw new Error(`下载 ${downloadId} 不能从 ${record.status} 完成`)
      }

      const sourcePath = await fileExists(record.temporaryPath)
        ? record.temporaryPath
        : (await fileExists(record.finalPath))
          ? record.finalPath
          : null
      if (!sourcePath) {
        throw new ProjectDownloadError('disk', '下载临时文件不存在')
      }
      const { size, sha256 } = await hashFile(sourcePath)
      let finalPath = record.finalPath
      if (sourcePath !== finalPath) {
        finalPath = await commitWithoutOverwrite(
          sourcePath,
          finalPath,
          sha256
        )
      }
      const finalName = basename(finalPath)
      const completedAt = new Date(this.now()).toISOString()
      const completed: ProjectDownloadRecord = {
        ...record,
        safeFileName: finalName,
        finalPath,
        size,
        sha256,
        status: 'completed',
        errorCategory: null,
        error: null,
        updatedAt: completedAt,
        completedAt
      }
      await this.writeUpdatedRecord(state, completed)
      await this.backfillIdempotency(completed)
      await this.incrementRuntimeCounters(completed)
      return completed
    })
  }

  async fail(
    downloadId: string,
    category: WorkflowFailureCategory,
    error: string
  ): Promise<ProjectDownloadRecord> {
    if (!isFailureCategory(category)) {
      throw new Error('下载失败分类无效')
    }
    return this.enqueue(async () => {
      const state = await this.read()
      const record = requireRecord(state, downloadId)
      if (record.status === 'completed' || record.status === 'cancelled') {
        return structuredClone(record)
      }
      const updated: ProjectDownloadRecord = {
        ...record,
        status: 'failed',
        retryCount: record.retryCount + 1,
        errorCategory: category,
        error: truncate(error, 4_000),
        updatedAt: new Date(this.now()).toISOString()
      }
      await this.writeUpdatedRecord(state, updated)
      return updated
    })
  }

  async cancel(downloadId: string): Promise<ProjectDownloadRecord> {
    return this.setStatus(downloadId, 'cancelled')
  }

  async recoverInterrupted(): Promise<ProjectDownloadRecord[]> {
    const state = await this.read()
    const recovered: ProjectDownloadRecord[] = []
    for (const record of state.records) {
      if (
        record.status !== 'reserved' &&
        record.status !== 'downloading'
      ) {
        continue
      }
      if (await fileExists(record.finalPath)) {
        recovered.push(await this.complete(record.downloadId))
      } else {
        recovered.push(
          await this.fail(
            record.downloadId,
            'unknown',
            (await fileExists(record.temporaryPath))
              ? '应用退出时下载未完成；临时文件已保留'
              : '应用退出时下载未完成且临时文件不存在'
          )
        )
      }
    }
    return recovered
  }

  private async setStatus(
    downloadId: string,
    status: 'downloading' | 'cancelled'
  ): Promise<ProjectDownloadRecord> {
    return this.enqueue(async () => {
      const state = await this.read()
      const record = requireRecord(state, downloadId)
      const allowed =
        status === 'downloading'
          ? record.status === 'reserved' || record.status === 'failed'
          : record.status !== 'completed'
      if (!allowed) {
        throw new Error(
          `下载 ${downloadId} 不能从 ${record.status} 转为 ${status}`
        )
      }
      const updated: ProjectDownloadRecord = {
        ...record,
        status,
        errorCategory:
          status === 'cancelled' ? 'cancelled' : null,
        error: status === 'cancelled' ? '用户取消下载' : null,
        updatedAt: new Date(this.now()).toISOString(),
        completedAt:
          status === 'cancelled'
            ? new Date(this.now()).toISOString()
            : null
      }
      await this.writeUpdatedRecord(state, updated)
      return updated
    })
  }

  private async writeUpdatedRecord(
    state: ProjectDownloadState,
    updated: ProjectDownloadRecord
  ): Promise<void> {
    await writeJsonAtomic(this.filePath, {
      schemaVersion: 1,
      records: state.records.map((record) =>
        record.downloadId === updated.downloadId ? updated : record
      )
    } satisfies ProjectDownloadState)
  }

  private async backfillIdempotency(
    record: ProjectDownloadRecord
  ): Promise<void> {
    await this.options.runtimeStore?.completeIdempotency({
      key: record.idempotencyKey,
      projectId: record.projectId,
      runtimeId: record.runtimeId,
      workflowNodeId: record.workflowNodeId,
      result: {
        downloadId: record.downloadId,
        finalPath: record.finalPath,
        sha256: record.sha256,
        size: record.size
      }
    })
  }

  private async incrementRuntimeCounters(
    record: ProjectDownloadRecord
  ): Promise<void> {
    const runtimeStore = this.options.runtimeStore
    if (!runtimeStore) {
      return
    }
    const exists = (await runtimeStore.read()).runtimes.some(
      ({ runtime }) => runtime.runtimeId === record.runtimeId
    )
    if (!exists) {
      return
    }
    await runtimeStore.incrementCounters(record.runtimeId, {
      downloaded: 1,
      downloadedBytes: record.size
    })
  }

  private async update<T>(
    transform: (
      state: ProjectDownloadState
    ) => Promise<{ state: ProjectDownloadState; result: T }>
  ): Promise<T> {
    return this.enqueue(async () => {
      const transformed = await transform(await this.read())
      await writeJsonAtomic(this.filePath, transformed.state)
      return transformed.result
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation)
    this.queue = pending.then(
      () => undefined,
      () => undefined
    )
    return pending
  }

  private async quarantineInvalidFile(): Promise<void> {
    const quarantinePath = `${this.filePath}.invalid-${Date.now()}-${randomUUID()}`
    await rename(this.filePath, quarantinePath).catch((error: unknown) => {
      if (!isNodeError(error, 'ENOENT')) {
        throw error
      }
    })
  }
}

export class ProjectDownloadError extends Error {
  constructor(
    readonly category: WorkflowFailureCategory,
    message: string
  ) {
    super(message)
  }
}

export function emptyDownloadState(): ProjectDownloadState {
  return { schemaVersion: 1, records: [] }
}

export function parseProjectDownloadState(
  value: unknown
): ProjectDownloadState | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'records']) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.records) ||
    value.records.length > 10_000
  ) {
    return null
  }
  const records: ProjectDownloadRecord[] = []
  const ids = new Set<string>()
  for (const candidate of value.records) {
    const record = parseDownloadRecord(candidate)
    if (!record || ids.has(record.downloadId)) {
      return null
    }
    ids.add(record.downloadId)
    records.push(record)
  }
  return { schemaVersion: 1, records }
}

export function createDownloadIdempotencyKey(
  projectId: string,
  intent: Pick<
    ProjectDownloadIntent,
    'businessItemId' | 'attachmentId' | 'sourceUrl'
  >
): string {
  const attachment =
    intent.attachmentId.trim() ||
    normalizeHttpUrl(intent.sourceUrl)
  const canonical = `${projectId}:${intent.businessItemId.trim()}:${attachment}`
  return canonical.length <= 500
    ? canonical
    : `${projectId}:sha256:${createHash('sha256')
        .update(canonical)
        .digest('hex')}`
}

function parseDownloadRecord(value: unknown): ProjectDownloadRecord | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'downloadId',
      'idempotencyKey',
      'projectId',
      'runtimeId',
      'workflowNodeId',
      'sourcePage',
      'sourceUrl',
      'businessItemId',
      'attachmentId',
      'originalFileName',
      'safeFileName',
      'temporaryPath',
      'finalPath',
      'mime',
      'size',
      'sha256',
      'status',
      'retryCount',
      'errorCategory',
      'error',
      'startedAt',
      'updatedAt',
      'completedAt'
    ]) ||
    typeof value.downloadId !== 'string' ||
    !/^download-[a-zA-Z0-9_-]{8,200}$/.test(value.downloadId) ||
    typeof value.idempotencyKey !== 'string' ||
    value.idempotencyKey.length === 0 ||
    value.idempotencyKey.length > 2_048 ||
    typeof value.projectId !== 'string' ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(value.projectId) ||
    typeof value.runtimeId !== 'string' ||
    !/^runtime-[a-zA-Z0-9_-]{8,200}$/.test(value.runtimeId) ||
    typeof value.workflowNodeId !== 'string' ||
    !/^[a-z][a-z0-9-]{0,79}$/.test(value.workflowNodeId) ||
    typeof value.sourcePage !== 'string' ||
    !isHttpUrl(value.sourcePage) ||
    typeof value.sourceUrl !== 'string' ||
    !isHttpUrl(value.sourceUrl) ||
    typeof value.businessItemId !== 'string' ||
    value.businessItemId.length === 0 ||
    value.businessItemId.length > 500 ||
    typeof value.attachmentId !== 'string' ||
    value.attachmentId.length > 500 ||
    typeof value.originalFileName !== 'string' ||
    value.originalFileName.length === 0 ||
    value.originalFileName.length > 1_000 ||
    typeof value.safeFileName !== 'string' ||
    sanitizeDownloadFileName(value.safeFileName) !== value.safeFileName ||
    typeof value.temporaryPath !== 'string' ||
    !isAbsolute(value.temporaryPath) ||
    typeof value.finalPath !== 'string' ||
    !isAbsolute(value.finalPath) ||
    (value.mime !== null &&
      (typeof value.mime !== 'string' || value.mime.length > 200)) ||
    !isIntegerBetween(value.size, 0, Number.MAX_SAFE_INTEGER) ||
    (value.sha256 !== null &&
      (typeof value.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.sha256))) ||
    typeof value.status !== 'string' ||
    ![
      'reserved',
      'downloading',
      'completed',
      'failed',
      'cancelled'
    ].includes(value.status) ||
    !isIntegerBetween(value.retryCount, 0, 1_000) ||
    (value.errorCategory !== null &&
      !isFailureCategory(value.errorCategory)) ||
    (value.error !== null &&
      (typeof value.error !== 'string' || value.error.length > 4_000)) ||
    !isIsoDate(value.startedAt) ||
    !isIsoDate(value.updatedAt) ||
    (value.completedAt !== null && !isIsoDate(value.completedAt))
  ) {
    return null
  }
  const terminal =
    value.status === 'completed' || value.status === 'cancelled'
  if (
    terminal !== (value.completedAt !== null) ||
    (value.status === 'completed' &&
      (value.sha256 === null || (value.size as number) < 0))
  ) {
    return null
  }
  return structuredClone(value) as unknown as ProjectDownloadRecord
}

async function chooseSafeFileName(
  root: string,
  rendered: string,
  records: ProjectDownloadRecord[]
): Promise<string> {
  const safe = sanitizeDownloadFileName(rendered)
  // Failed/cancelled records keep audit evidence, but an absent final file
  // must remain reusable by a safe retry of the same business attachment.
  const occupied = new Set(
    records
      .filter(
        (record) =>
          dirname(record.finalPath) === root &&
          (record.status === 'reserved' ||
            record.status === 'downloading' ||
            record.status === 'completed')
      )
      .map((record) => record.safeFileName.toLowerCase())
  )
  if (
    !occupied.has(safe.toLowerCase()) &&
    !(await fileExists(join(root, safe)))
  ) {
    return safe
  }
  const extension = extname(safe)
  const stem = basename(safe, extension)
  for (let suffix = 2; suffix <= 10_000; suffix += 1) {
    const candidate = sanitizeDownloadFileName(
      `${stem} (${suffix})${extension}`
    )
    if (
      !occupied.has(candidate.toLowerCase()) &&
      !(await fileExists(join(root, candidate)))
    ) {
      return candidate
    }
  }
  throw new Error('无法创建不冲突的下载文件名')
}

function renderFileName(
  template: string,
  intent: ProjectDownloadIntent
): string {
  const tokens: Record<string, string> = {
    postId: intent.businessItemId,
    businessItemId: intent.businessItemId,
    attachmentId: intent.attachmentId,
    fileName: intent.originalFileName
  }
  const rendered = template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (
    _match,
    key: string
  ) => tokens[key] ?? '')
  return sanitizeDownloadFileName(rendered)
}

async function commitWithoutOverwrite(
  temporaryPath: string,
  requestedFinalPath: string,
  sha256: string
): Promise<string> {
  let finalPath = requestedFinalPath
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    if (await fileExists(finalPath)) {
      const existing = await hashFile(finalPath)
      if (existing.sha256 === sha256) {
        await rm(temporaryPath, { force: true })
        return finalPath
      }
      finalPath = addPathSuffix(requestedFinalPath, attempt + 2)
      continue
    }
    try {
      await link(temporaryPath, finalPath)
      await rm(temporaryPath, { force: true })
      return finalPath
    } catch (error) {
      if (isNodeError(error, 'EEXIST')) {
        finalPath = addPathSuffix(requestedFinalPath, attempt + 2)
        continue
      }
      if (
        isNodeError(error, 'EPERM') ||
        isNodeError(error, 'ENOTSUP') ||
        isNodeError(error, 'EXDEV')
      ) {
        await copyFile(temporaryPath, finalPath, constants.COPYFILE_EXCL)
        await rm(temporaryPath, { force: true })
        return finalPath
      }
      throw error
    }
  }
  throw new Error('无法提交下载文件：文件名冲突过多')
}

function addPathSuffix(filePath: string, suffix: number): string {
  const extension = extname(filePath)
  return join(
    dirname(filePath),
    `${basename(filePath, extension)} (${suffix})${extension}`
  )
}

async function hashFile(
  filePath: string
): Promise<{ size: number; sha256: string }> {
  const metadata = await stat(filePath)
  if (!metadata.isFile()) {
    throw new ProjectDownloadError('disk', '下载结果不是普通文件')
  }
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', resolve)
  })
  return { size: metadata.size, sha256: hash.digest('hex') }
}

async function defaultAvailableBytes(path: string): Promise<number> {
  const result = await statfs(path)
  return result.bavail * result.bsize
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return false
    }
    throw error
  }
}

function ensureInside(root: string, target: string): string {
  const child = relative(root, target)
  if (
    child === '' ||
    child === '..' ||
    child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(child)
  ) {
    throw new Error('下载路径逃逸项目目录')
  }
  return target
}

function validateIntent(intent: ProjectDownloadIntent): void {
  if (
    !/^runtime-[a-zA-Z0-9_-]{8,200}$/.test(intent.runtimeId) ||
    !/^[a-z][a-z0-9-]{0,79}$/.test(intent.workflowNodeId) ||
    !isHttpUrl(intent.sourcePage) ||
    !isHttpUrl(intent.sourceUrl) ||
    intent.businessItemId.trim().length === 0 ||
    intent.businessItemId.length > 500 ||
    intent.attachmentId.length > 500 ||
    intent.originalFileName.length === 0 ||
    intent.originalFileName.length > 1_000 ||
    (intent.mime !== undefined && intent.mime.length > 200) ||
    (intent.expectedBytes !== undefined &&
      !isIntegerBetween(intent.expectedBytes, 0, Number.MAX_SAFE_INTEGER))
  ) {
    throw new Error('下载意图格式无效')
  }
}

function normalizeHttpUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('下载来源 URL 必须是 HTTP(S)')
  }
  return url.toString()
}

function isHttpUrl(value: string): boolean {
  try {
    normalizeHttpUrl(value)
    return true
  } catch {
    return false
  }
}

function createDownloadId(createId: () => string): string {
  const value = createId()
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z0-9_-]{8,200}$/.test(value)
  ) {
    throw new Error('无法创建 Download ID')
  }
  return `download-${value}`
}

function requireRecord(
  state: ProjectDownloadState,
  downloadId: string
): ProjectDownloadRecord {
  const record = state.records.find(
    (candidate) => candidate.downloadId === downloadId
  )
  if (!record) {
    throw new Error(`下载记录不存在：${downloadId}`)
  }
  return record
}

function pruneRecords(
  records: ProjectDownloadRecord[]
): ProjectDownloadRecord[] {
  if (records.length <= 10_000) {
    return records
  }
  const active = records.filter(
    (record) =>
      record.status === 'reserved' || record.status === 'downloading'
  )
  const terminal = records
    .filter(
      (record) =>
        record.status !== 'reserved' && record.status !== 'downloading'
    )
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
  return [...terminal.slice(-(10_000 - active.length)), ...active]
}

function isFailureCategory(value: unknown): value is WorkflowFailureCategory {
  return (
    typeof value === 'string' &&
    [
      'network',
      'timeout',
      'authentication',
      'page-changed',
      'renderer',
      'disk',
      'cancelled',
      'unknown'
    ].includes(value)
  )
}

function isIntegerBetween(
  value: unknown,
  minimum: number,
  maximum: number
): boolean {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  )
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[]
): boolean {
  const keys = Object.keys(value)
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum
    ? value
    : `${value.slice(0, maximum - 1)}…`
}
