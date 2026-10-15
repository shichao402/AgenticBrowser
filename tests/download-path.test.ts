import { describe, expect, it } from 'vitest'

import { sanitizeDownloadFileName } from '../src/main/download-path'

describe('sanitizeDownloadFileName', () => {
  it('removes path separators, Windows reserved characters, and trailing dots', () => {
    expect(sanitizeDownloadFileName('../meeting:<2026>?*.mp3. ')).toBe(
      '.._meeting__2026___.mp3'
    )
  })

  it('uses a safe fallback for an empty or reserved-only name', () => {
    expect(sanitizeDownloadFileName('...')).toBe('download')
    expect(sanitizeDownloadFileName('   ')).toBe('download')
    expect(sanitizeDownloadFileName('CON.mp3')).toBe('_CON.mp3')
  })

  it('bounds the filename length', () => {
    expect(sanitizeDownloadFileName(`${'a'.repeat(300)}.mp3`)).toHaveLength(180)
  })
})
