import type {
  ContentFilterDefinition,
  ContentFilterNetworkRule,
  ContentFilterResourceType
} from '../shared/contracts'
import { urlMatchesStrategyPattern } from './strategy-match'

export interface ContentFilterDecision {
  blocked: boolean
  ruleId: string | null
}

export interface ContentFilterHit {
  ruleId: string
  action: 'allow' | 'block'
  url: string
  resourceType: ContentFilterResourceType
}

export class ContentFilter {
  private definition: ContentFilterDefinition

  constructor(
    definition: ContentFilterDefinition,
    private readonly onHit?: (hit: ContentFilterHit) => void
  ) {
    this.definition = cloneDefinition(definition)
  }

  update(definition: ContentFilterDefinition): void {
    this.definition = cloneDefinition(definition)
  }

  decide(url: string, electronResourceType: string): ContentFilterDecision {
    const resourceType = normalizeResourceType(electronResourceType)
    if (!this.definition.enabled || !resourceType || !isHttpUrl(url)) {
      return { blocked: false, ruleId: null }
    }

    const matching = this.definition.networkRules.filter(
      (rule) =>
        rule.resourceTypes.includes(resourceType) &&
        urlMatchesStrategyPattern(url, rule.urlPattern)
    )
    const rule =
      matching.find((candidate) => candidate.action === 'allow') ??
      matching.find((candidate) => candidate.action === 'block')
    if (!rule) {
      return { blocked: false, ruleId: null }
    }
    this.onHit?.({
      ruleId: rule.id,
      action: rule.action,
      url,
      resourceType
    })
    return {
      blocked: rule.action === 'block',
      ruleId: rule.id
    }
  }

  cssForUrl(url: string): { css: string; ruleIds: string[] } {
    if (!this.definition.enabled || !isHttpUrl(url)) {
      return { css: '', ruleIds: [] }
    }
    const rules = this.definition.cssRules.filter((rule) =>
      urlMatchesStrategyPattern(url, rule.urlPattern)
    )
    return {
      css: rules
        .flatMap((rule) => rule.selectors)
        .map((selector) => `${selector}{display:none!important;}`)
        .join('\n'),
      ruleIds: rules.map((rule) => rule.id)
    }
  }

  getDefinition(): ContentFilterDefinition {
    return cloneDefinition(this.definition)
  }
}

export function normalizeResourceType(
  electronResourceType: string
): ContentFilterResourceType | null {
  switch (electronResourceType) {
    case 'stylesheet':
    case 'image':
    case 'media':
    case 'font':
    case 'script':
      return electronResourceType
    case 'xhr':
    case 'fetch':
      return 'xhr'
    case 'mainFrame':
    case 'subFrame':
    case 'webSocket':
      return null
    default:
      return 'other'
  }
}

function cloneDefinition(
  definition: ContentFilterDefinition
): ContentFilterDefinition {
  return {
    enabled: definition.enabled,
    networkRules: definition.networkRules.map(cloneNetworkRule),
    cssRules: definition.cssRules.map((rule) => ({
      ...rule,
      selectors: [...rule.selectors]
    }))
  }
}

function cloneNetworkRule(
  rule: ContentFilterNetworkRule
): ContentFilterNetworkRule {
  return {
    ...rule,
    resourceTypes: [...rule.resourceTypes]
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
