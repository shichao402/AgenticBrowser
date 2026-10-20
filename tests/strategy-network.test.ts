import { describe, expect, it } from 'vitest'

import {
  isRedirectStatus,
  parseStrategyBootstrapRequest,
  readStrategyResponseBody,
  sanitizeStrategyRequestHeaders,
  selectStrategyResponseHeaders
} from '../src/main/strategy-network'

describe('parseStrategyBootstrapRequest', () => {
  it('accepts a well formed bootstrap payload', () => {
    expect(
      parseStrategyBootstrapRequest({
        href: 'https://example.com/a?b=1',
        isMainFrame: false
      })
    ).toEqual({ href: 'https://example.com/a?b=1', isMainFrame: false })
  })

  it('rejects non objects', () => {
    for (const value of [null, undefined, 'href', 42, true]) {
      expect(parseStrategyBootstrapRequest(value)).toBeNull()
    }
  })

  it('rejects payloads missing either field', () => {
    expect(parseStrategyBootstrapRequest({ href: 'https://a.test' })).toBeNull()
    expect(parseStrategyBootstrapRequest({ isMainFrame: true })).toBeNull()
  })

  it('rejects wrong field types', () => {
    expect(
      parseStrategyBootstrapRequest({ href: 1, isMainFrame: true })
    ).toBeNull()
    expect(
      parseStrategyBootstrapRequest({
        href: 'https://a.test',
        isMainFrame: 'yes'
      })
    ).toBeNull()
  })

  it('bounds the href length at exactly 8192 characters', () => {
    const atLimit = `https://a.test/${'x'.repeat(8192 - 'https://a.test/'.length)}`
    expect(atLimit).toHaveLength(8192)
    expect(
      parseStrategyBootstrapRequest({ href: atLimit, isMainFrame: true })
    ).not.toBeNull()

    const overLimit = `${atLimit}x`
    expect(overLimit).toHaveLength(8193)
    expect(
      parseStrategyBootstrapRequest({ href: overLimit, isMainFrame: true })
    ).toBeNull()
  })
})

describe('sanitizeStrategyRequestHeaders', () => {
  it('lowercases names and preserves values', () => {
    expect(
      sanitizeStrategyRequestHeaders({ Accept: 'text/html', 'X-Trace': 'abc' })
    ).toEqual({ accept: 'text/html', 'x-trace': 'abc' })
  })

  it('returns an empty object for empty input', () => {
    expect(sanitizeStrategyRequestHeaders({})).toEqual({})
  })

  it('rejects credential bearing headers', () => {
    const forbidden = [
      'authorization',
      'Authorization',
      'cookie',
      'Cookie',
      'host',
      'origin',
      'referer',
      'proxy-authorization',
      'sec-fetch-site'
    ]
    for (const name of forbidden) {
      expect(() =>
        sanitizeStrategyRequestHeaders({ [name]: 'value' })
      ).toThrowError(/Strategy 请求头不允许/)
    }
  })

  it('rejects names violating the token grammar', () => {
    for (const name of ['bad header', 'with:colon', 'quo"te', '']) {
      expect(() =>
        sanitizeStrategyRequestHeaders({ [name]: 'value' })
      ).toThrowError(/Strategy 请求头不允许/)
    }
  })

  it('rejects values carrying CR or LF', () => {
    // 头注入的攻击面：一旦值里能塞进换行，就能伪造额外的头，
    // 甚至改动请求行。
    for (const value of ['a\r\nX-Evil: 1', 'line\nbreak', 'trailing\r']) {
      expect(() =>
        sanitizeStrategyRequestHeaders({ 'x-safe': value })
      ).toThrowError(/Strategy 请求头不允许/)
    }
  })

  it('accepts headers outside the forbidden prefixes', () => {
    expect(
      sanitizeStrategyRequestHeaders({
        'if-none-match': '"abc"',
        'x-custom-header': 'ok'
      })
    ).toEqual({ 'if-none-match': '"abc"', 'x-custom-header': 'ok' })
  })
})

describe('readStrategyResponseBody', () => {
  function responseOf(text: string): Response {
    return new Response(text)
  }

  it('reads the full body below the limit', async () => {
    const buffer = await readStrategyResponseBody(responseOf('hello'), 10)
    expect(buffer.toString('utf8')).toBe('hello')
  })

  it('accepts a body of exactly the maximum size', async () => {
    const buffer = await readStrategyResponseBody(responseOf('12345'), 5)
    expect(buffer.toString('utf8')).toBe('12345')
  })

  it('rejects a body one byte over the maximum size', async () => {
    await expect(
      readStrategyResponseBody(responseOf('123456'), 5)
    ).rejects.toThrowError(/1 MiB/)
  })

  it('returns an empty buffer when the body is absent', async () => {
    const response = new Response(null)
    expect(response.body).toBeNull()
    const buffer = await readStrategyResponseBody(response, 1024)
    expect(buffer.byteLength).toBe(0)
  })

  it('defaults to a 1 MiB ceiling', async () => {
    const justUnder = new Uint8Array(1024 * 1024)
    await expect(
      readStrategyResponseBody(new Response(justUnder))
    ).resolves.toHaveLength(1024 * 1024)

    const justOver = new Uint8Array(1024 * 1024 + 1)
    await expect(
      readStrategyResponseBody(new Response(justOver))
    ).rejects.toThrowError(/1 MiB/)
  })
})

describe('selectStrategyResponseHeaders', () => {
  it('keeps only the content negotiation allowlist', () => {
    const headers = new Headers({
      'Content-Type': 'text/html',
      'Cache-Control': 'no-store',
      ETag: '"v1"',
      'Set-Cookie': 'session=secret',
      'X-Internal': 'leak'
    })
    expect(selectStrategyResponseHeaders(headers)).toEqual({
      'content-type': 'text/html',
      'cache-control': 'no-store',
      etag: '"v1"'
    })
  })

  it('drops credential headers entirely', () => {
    const headers = new Headers({
      'set-cookie': 'a=b',
      'www-authenticate': 'Basic'
    })
    expect(selectStrategyResponseHeaders(headers)).toEqual({})
  })

  it('returns an empty object when nothing is allowlisted', () => {
    expect(selectStrategyResponseHeaders(new Headers())).toEqual({})
  })
})

describe('isRedirectStatus', () => {
  it('recognises the redirect statuses the bridge follows', () => {
    for (const status of [301, 302, 303, 307, 308]) {
      expect(isRedirectStatus(status)).toBe(true)
    }
  })

  it('treats neighbouring codes as non redirects', () => {
    for (const status of [200, 204, 300, 304, 305, 306, 309, 400, 500]) {
      expect(isRedirectStatus(status)).toBe(false)
    }
  })
})
