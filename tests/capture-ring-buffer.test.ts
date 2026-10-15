import { describe, expect, it } from 'vitest'

import { CaptureRingBuffer } from '../src/main/capture-ring-buffer'

describe('CaptureRingBuffer', () => {
  it('evicts oldest frames to enforce frame and byte limits', () => {
    const ring = new CaptureRingBuffer(3, 10)

    expect(ring.push(Buffer.alloc(4, 1))).toBe(true)
    expect(ring.push(Buffer.alloc(4, 2))).toBe(true)
    expect(ring.push(Buffer.alloc(4, 3))).toBe(true)

    expect(ring.getSnapshot()).toMatchObject({
      frameCount: 2,
      byteLength: 8,
      evictedFrames: 1,
      firstSequence: 2,
      lastSequence: 3
    })
  })

  it('drops an oversized frame without violating the byte cap', () => {
    const ring = new CaptureRingBuffer(3, 5)

    expect(ring.push(Buffer.alloc(6))).toBe(false)
    expect(ring.getSnapshot()).toMatchObject({
      frameCount: 0,
      byteLength: 0,
      droppedFrames: 1
    })
  })

  it('freezes retained evidence and rejects subsequent frames', () => {
    const ring = new CaptureRingBuffer(3, 100)
    ring.push(Buffer.from('before-failure'))

    expect(ring.freeze('renderer-stalled')).toMatchObject({
      frameCount: 1,
      frozen: true,
      freezeReason: 'renderer-stalled'
    })
    expect(ring.push(Buffer.from('after-failure'))).toBe(false)
    expect(ring.getSnapshot()).toMatchObject({
      frameCount: 1,
      droppedFrames: 1
    })
  })
})
