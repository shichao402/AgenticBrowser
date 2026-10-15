import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  createKnowledgePlanetProjectDraft,
  createKnowledgePlanetStrategyDraft,
  KNOWLEDGE_PLANET_ENTRY_URL,
  KNOWLEDGE_PLANET_STRATEGY_ID
} from '../src/main/knowledge-planet-pilot'
import { parseProjectDraft } from '../src/main/project-store'
import { parseStrategyManifest } from '../src/main/strategy-store'

describe('knowledge planet pilot templates', () => {
  it('creates a safe disabled Project template', () => {
    const draft = createKnowledgePlanetProjectDraft({
      profileId: 'knowledge-profile',
      outputRoot: join(tmpdir(), 'agentic-knowledge-output')
    })

    expect(parseProjectDraft(draft)).toEqual(draft)
    expect(draft).toMatchObject({
      enabled: false,
      startupPages: [KNOWLEDGE_PLANET_ENTRY_URL],
      strategies: [{ id: KNOWLEDGE_PLANET_STRATEGY_ID }],
      runtime: { mode: 'manual' }
    })
  })

  it('creates a valid configurable Strategy without broad host access', () => {
    const draft = createKnowledgePlanetStrategyDraft({
      includeKeywords: ['会议', '语音'],
      excludeKeywords: ['招聘']
    })

    expect(parseStrategyManifest(draft.manifest)).toEqual(draft.manifest)
    expect(draft.manifest.permissions).not.toContain('network.request')
    expect(draft.manifest.permissions).not.toContain('main-world')
    expect(draft.manifest.config).toMatchObject({
      includeKeywords: ['会议', '语音'],
      excludeKeywords: ['招聘'],
      itemSelectors: expect.arrayContaining(['.topic-container']),
      textSelectors: expect.arrayContaining(['.talk-content-container']),
      downloadButtonSelectors: expect.arrayContaining([
        'app-file-gallery .download'
      ])
    })
    expect(draft.source).toContain('project.item-observed')
    expect(draft.source).toContain('project.authentication-required')
    expect(draft.source).toContain('download.intent')
    expect(draft.source).toContain('reservation.canStart !== true')
  })
})
