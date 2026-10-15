import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  AUTOMATION_PLAYGROUND_FORM_URL,
  AUTOMATION_PLAYGROUND_PROJECT_ID,
  AUTOMATION_PLAYGROUND_STRATEGY_ID,
  createAutomationPlaygroundProjectDraft,
  createAutomationPlaygroundStrategyDraft
} from '../src/main/automation-playground-pilot'
import { parseProjectDraft } from '../src/main/project-store'
import { parseStrategyManifest } from '../src/main/strategy-store'

describe('automation playground pilot templates', () => {
  it('creates a safe disabled Project template', () => {
    const draft = createAutomationPlaygroundProjectDraft({
      profileId: 'selenium-profile',
      outputRoot: join(tmpdir(), 'agentic-selenium-output')
    })

    expect(parseProjectDraft(draft)).toEqual(draft)
    expect(draft).toMatchObject({
      id: AUTOMATION_PLAYGROUND_PROJECT_ID,
      enabled: false,
      startupPages: [AUTOMATION_PLAYGROUND_FORM_URL],
      strategies: [{ id: AUTOMATION_PLAYGROUND_STRATEGY_ID }],
      runtime: { mode: 'manual' },
      capabilities: {
        defaults: {
          downloads: true,
          popups: false,
          notifications: false,
          geolocation: false,
          media: false,
          clipboardRead: false,
          fullscreen: false
        }
      }
    })
  })

  it('uses only Selenium public test assets and narrow permissions', () => {
    const draft = createAutomationPlaygroundStrategyDraft()

    expect(parseStrategyManifest(draft.manifest)).toEqual(draft.manifest)
    expect(draft.manifest.matches).toEqual([
      'https://www.selenium.dev/selenium/web/*'
    ])
    expect(draft.manifest.permissions).not.toContain('network.request')
    expect(draft.manifest.permissions).not.toContain('main-world')
    expect(draft.manifest.permissions).not.toContain('config.read')
    expect(draft.source).toContain('playground.form.completed')
    expect(draft.source).toContain('playground.dynamic.completed')
    expect(draft.source).toContain('project.page-changed')
    expect(draft.source).toContain('/downloads/file_1.txt')
    expect(draft.source).toContain('reservation.canStart === true')
  })
})
