import { describe, expect, it, vi } from 'vitest'

import {
  ContentFilter,
  normalizeResourceType
} from '../src/main/content-filter'
import type { ContentFilterDefinition } from '../src/shared/contracts'

describe('ContentFilter', () => {
  it('blocks only explicitly matching subresources and logs the hit', () => {
    const onHit = vi.fn()
    const filter = new ContentFilter(definition(), onHit)

    expect(
      filter.decide('https://ads.example.com/banner.png', 'image')
    ).toEqual({ blocked: true, ruleId: 'block-ad-images' })
    expect(
      filter.decide('https://ads.example.com/banner.png', 'script')
    ).toEqual({ blocked: false, ruleId: null })
    expect(
      filter.decide('https://ads.example.com/', 'mainFrame')
    ).toEqual({ blocked: false, ruleId: null })
    expect(onHit).toHaveBeenCalledOnce()
  })

  it('gives a matching allow rule precedence over block rules', () => {
    const value = definition()
    value.networkRules.unshift({
      id: 'allow-logo',
      action: 'allow',
      urlPattern: 'https://ads.example.com/logo.png',
      resourceTypes: ['image']
    })
    const filter = new ContentFilter(value)

    expect(
      filter.decide('https://ads.example.com/logo.png', 'image')
    ).toEqual({ blocked: false, ruleId: 'allow-logo' })
  })

  it('builds CSS only for matching pages', () => {
    const filter = new ContentFilter(definition())
    expect(filter.cssForUrl('https://example.com/feed')).toEqual({
      css: '.overlay{display:none!important;}\n.ad-card{display:none!important;}',
      ruleIds: ['hide-distractions']
    })
    expect(filter.cssForUrl('https://other.example/feed')).toEqual({
      css: '',
      ruleIds: []
    })
  })

  it('never maps documents, frames, or web sockets to blockable types', () => {
    expect(normalizeResourceType('mainFrame')).toBeNull()
    expect(normalizeResourceType('subFrame')).toBeNull()
    expect(normalizeResourceType('webSocket')).toBeNull()
    expect(normalizeResourceType('fetch')).toBe('xhr')
  })
})

function definition(): ContentFilterDefinition {
  return {
    enabled: true,
    networkRules: [
      {
        id: 'block-ad-images',
        action: 'block',
        urlPattern: 'https://ads.example.com/*',
        resourceTypes: ['image']
      }
    ],
    cssRules: [
      {
        id: 'hide-distractions',
        urlPattern: 'https://example.com/*',
        selectors: ['.overlay', '.ad-card']
      }
    ]
  }
}
