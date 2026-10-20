import { describe, expect, it } from 'vitest'

import { normalizeNavigationUrl } from '../src/main/navigation'

describe('normalizeNavigationUrl', () => {
  it('adds https to a bare host', () => {
    expect(normalizeNavigationUrl('example.com')).toBe('https://example.com/')
  })

  it('preserves an https URL', () => {
    expect(normalizeNavigationUrl('https://example.com/path?q=1')).toBe(
      'https://example.com/path?q=1'
    )
  })

  it('allows http for local and compatibility testing', () => {
    expect(normalizeNavigationUrl('http://localhost:4173')).toBe(
      'http://localhost:4173/'
    )
  })

  it.each([
    '',
    '   ',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/plain,test'
  ])('rejects an unsafe input: %s', (input) => {
    expect(() => normalizeNavigationUrl(input)).toThrow()
  })
})
