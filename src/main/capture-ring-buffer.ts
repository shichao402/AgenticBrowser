export interface CaptureFrame {
  sequence: number
  capturedAt: string
  jpeg: Buffer
}

export interface CaptureRingSnapshot {
  frameCount: number
  byteLength: number
  evictedFrames: number
  droppedFrames: number
  frozen: boolean
  freezeReason: string | null
  firstSequence: number | null
  lastSequence: number | null
}

export class CaptureRingBuffer {
  private readonly frames: CaptureFrame[] = []
  private byteLength = 0
  private sequence = 0
  private evictedFrames = 0
  private droppedFrames = 0
  private freezeReason: string | null = null

  constructor(
    readonly maxFrames: number,
    readonly maxBytes: number
  ) {
    if (!Number.isInteger(maxFrames) || maxFrames <= 0) {
      throw new Error('maxFrames 必须是正整数')
    }
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('maxBytes 必须是正整数')
    }
  }

  push(jpeg: Buffer, capturedAt = new Date().toISOString()): boolean {
    if (this.freezeReason !== null) {
      this.droppedFrames += 1
      return false
    }

    if (jpeg.byteLength === 0 || jpeg.byteLength > this.maxBytes) {
      this.droppedFrames += 1
      return false
    }

    const frame: CaptureFrame = {
      sequence: ++this.sequence,
      capturedAt,
      jpeg
    }
    this.frames.push(frame)
    this.byteLength += jpeg.byteLength

    while (
      this.frames.length > this.maxFrames ||
      this.byteLength > this.maxBytes
    ) {
      const evicted = this.frames.shift()
      if (!evicted) {
        break
      }
      this.byteLength -= evicted.jpeg.byteLength
      this.evictedFrames += 1
    }

    return true
  }

  freeze(reason: string): CaptureRingSnapshot {
    const normalized = reason.trim()
    if (normalized.length === 0) {
      throw new Error('冻结原因不能为空')
    }
    this.freezeReason ??= normalized
    return this.getSnapshot()
  }

  getFrames(): readonly CaptureFrame[] {
    return this.frames
  }

  getSnapshot(): CaptureRingSnapshot {
    return {
      frameCount: this.frames.length,
      byteLength: this.byteLength,
      evictedFrames: this.evictedFrames,
      droppedFrames: this.droppedFrames,
      frozen: this.freezeReason !== null,
      freezeReason: this.freezeReason,
      firstSequence: this.frames[0]?.sequence ?? null,
      lastSequence: this.frames.at(-1)?.sequence ?? null
    }
  }

  clear(): void {
    this.frames.length = 0
    this.byteLength = 0
    this.sequence = 0
    this.evictedFrames = 0
    this.droppedFrames = 0
    this.freezeReason = null
  }
}
