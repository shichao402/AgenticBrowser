import type {
  JsonValue,
  ProjectDraft,
  ProjectRuntimeMode,
  StrategyDraft
} from '../shared/contracts'
import { createCapabilityPolicy } from './capability-store'

export const KNOWLEDGE_PLANET_ENTRY_URL = 'https://wx.zsxq.com/dweb'
export const KNOWLEDGE_PLANET_PROJECT_ID = 'knowledge-planet-audio'
export const KNOWLEDGE_PLANET_STRATEGY_ID =
  'knowledge-planet-collector'
export const KNOWLEDGE_PLANET_STRATEGY_VERSION = '0.1.0'

export interface KnowledgePlanetStrategyOptions {
  matches?: string[]
  includeKeywords?: string[]
  excludeKeywords?: string[]
  includeRegexes?: string[]
  itemSelectors?: string[]
  textSelectors?: string[]
  audioSelectors?: string[]
  downloadButtonSelectors?: string[]
  detailLinkSelectors?: string[]
  idAttributes?: string[]
  maximumItems?: number
}

export interface KnowledgePlanetProjectOptions {
  profileId: string
  outputRoot: string
  entryUrl?: string
  runtimeMode?: Extract<ProjectRuntimeMode, 'manual' | 'resident'>
  enabled?: boolean
  maxRunMs?: number
}

export function createKnowledgePlanetStrategyDraft(
  options: KnowledgePlanetStrategyOptions = {}
): StrategyDraft {
  const config: Record<string, JsonValue> = {
    includeKeywords:
      options.includeKeywords ?? ['请配置需要匹配的关键词'],
    excludeKeywords: options.excludeKeywords ?? [],
    includeRegexes: options.includeRegexes ?? [],
    itemSelectors:
      options.itemSelectors ?? [
        '[data-topic-id]',
        '[data-agentic-topic-id]',
        '.topic-container',
        'app-topic',
        'app-topic-item',
        '.topic-item',
        '.topic'
      ],
    textSelectors:
      options.textSelectors ?? [
        '[data-topic-text]',
        '.talk-content-container',
        '.article-content-container',
        '.q-content-container',
        '.answer-content-container',
        'app-talk-content',
        '.topic-content',
        '.talk-content',
        '.content'
      ],
    audioSelectors:
      options.audioSelectors ?? [
        'a[data-agentic-audio]',
        'a[href*=".mp3"]',
        'audio[src]',
        'audio source[src]'
      ],
    downloadButtonSelectors:
      options.downloadButtonSelectors ?? [
        'app-file-gallery .download',
        '.file-gallery .download',
        '[data-file-id].download',
        '[data-file-id] .download'
      ],
    detailLinkSelectors:
      options.detailLinkSelectors ?? [
        'a[data-topic-detail]',
        'a[href*="/topic/"]',
        'a[href*="topic_detail"]',
        'a[href*="/topics/"]'
      ],
    idAttributes:
      options.idAttributes ?? [
        'data-topic-id',
        'data-agentic-topic-id',
        'data-id'
      ],
    maximumItems: options.maximumItems ?? 100
  }
  return {
    manifest: {
      id: KNOWLEDGE_PLANET_STRATEGY_ID,
      name: '知识星球文本与 MP3 采集',
      version: KNOWLEDGE_PLANET_STRATEGY_VERSION,
      matches: options.matches ?? ['https://wx.zsxq.com/*'],
      excludes: [],
      runAt: 'document-idle',
      frames: 'top',
      permissions: [
        'dom.read',
        'dom.write',
        'dom.click',
        'config.read',
        'log',
        'project.emit-event'
      ],
      networkMatches: [],
      config,
      timeouts: {
        startupMs: 15_000,
        heartbeatMs: 30_000
      }
    },
    source: KNOWLEDGE_PLANET_COLLECTOR_SOURCE,
    enabled: true
  }
}

export function createKnowledgePlanetProjectDraft(
  options: KnowledgePlanetProjectOptions
): ProjectDraft {
  const entryUrl = options.entryUrl ?? KNOWLEDGE_PLANET_ENTRY_URL
  return {
    id: KNOWLEDGE_PLANET_PROJECT_ID,
    name: '知识星球文本与 MP3 采集',
    profileId: options.profileId,
    startupPages: [entryUrl],
    strategies: [
      {
        id: KNOWLEDGE_PLANET_STRATEGY_ID,
        version: KNOWLEDGE_PLANET_STRATEGY_VERSION
      }
    ],
    runtime: {
      mode: options.runtimeMode ?? 'manual',
      timezone: 'Asia/Shanghai',
      priority: 10,
      maxRunMs: options.maxRunMs ?? 5 * 60 * 1_000
    },
    workflow: {
      version: 1,
      entryNodeId: 'open-feed',
      nodes: [
        {
          id: 'open-feed',
          kind: 'navigate',
          url: entryUrl,
          next: 'wait-cycle',
          timeoutMs: 30_000,
          maxAttempts: 3,
          checkpoint: true,
          onFailure: {
            authentication: 'wait-cycle'
          }
        },
        {
          id: 'wait-cycle',
          kind: 'wait-for-event',
          eventName: 'download.completed',
          next: 'finished',
          timeoutMs: 2 * 60 * 1_000,
          maxAttempts: 2,
          checkpoint: true
        },
        {
          id: 'finished',
          kind: 'complete',
          timeoutMs: 1_000,
          maxAttempts: 1,
          checkpoint: true
        }
      ]
    },
    output: {
      root: options.outputRoot,
      maxBytes: 10 * 1024 ** 3,
      fileNameTemplate: '{postId}-{fileName}'
    },
    capabilities: createCapabilityPolicy(),
    filter: {
      enabled: false,
      networkRules: [],
      cssRules: []
    },
    retry: {
      maxConsecutiveFailures: 3,
      baseBackoffMs: 2_000,
      maxBackoffMs: 60_000
    },
    enabled: options.enabled ?? false
  }
}

export const KNOWLEDGE_PLANET_COLLECTOR_SOURCE = String.raw`
const config = agenticStrategy.config
const asStrings = (value) =>
  Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string')
    : []
const itemSelectors = asStrings(config.itemSelectors)
const textSelectors = asStrings(config.textSelectors)
const audioSelectors = asStrings(config.audioSelectors)
const downloadButtonSelectors = asStrings(config.downloadButtonSelectors)
const detailLinkSelectors = asStrings(config.detailLinkSelectors)
const idAttributes = asStrings(config.idAttributes)
const includeKeywords = asStrings(config.includeKeywords)
  .map((entry) => entry.trim().toLocaleLowerCase())
  .filter(Boolean)
const excludeKeywords = asStrings(config.excludeKeywords)
  .map((entry) => entry.trim().toLocaleLowerCase())
  .filter(Boolean)
const includeRegexes = asStrings(config.includeRegexes)
  .map((entry) => {
    try {
      return new RegExp(entry, 'iu')
    } catch {
      return null
    }
  })
  .filter(Boolean)
const maximumItems =
  Number.isSafeInteger(config.maximumItems) &&
  config.maximumItems > 0
    ? Math.min(config.maximumItems, 500)
    : 100
const pendingKey = '__agentic_knowledge_planet_candidate_v1'

const queryAll = (root, selectors) => {
  const values = []
  const seen = new Set()
  for (const selector of selectors) {
    try {
      for (const element of root.querySelectorAll(selector)) {
        if (!seen.has(element)) {
          seen.add(element)
          values.push(element)
        }
      }
    } catch {
      // Ignore an invalid user-supplied selector and continue with fallbacks.
    }
  }
  return values
}
const firstMatch = (root, selectors) => queryAll(root, selectors)[0] || null
const absoluteUrl = (value) => {
  try {
    const url = new URL(value, location.href)
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.toString()
      : null
  } catch {
    return null
  }
}
const fnv = (value) => {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}
const itemText = (element) => {
  const selected = queryAll(element, textSelectors)
  const outer = selected.filter(
    (candidate) =>
      !selected.some(
        (other) => other !== candidate && other.contains(candidate)
      )
  )
  return ((outer.length > 0 ? outer : [element])
    .map((candidate) => candidate.textContent || '')
    .join('\n'))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50000)
}
const detailUrl = (element) => {
  const anchor = firstMatch(element, detailLinkSelectors)
  return anchor ? absoluteUrl(anchor.getAttribute('href') || '') : null
}
const itemId = (element, text, url) => {
  for (const attribute of idAttributes) {
    const value = element.getAttribute(attribute)
    if (value && value.trim()) {
      return value.trim().slice(0, 500)
    }
  }
  const match = url?.match(/(?:topic_detail|topics?)\/(\d+)/i)
  return match?.[1] || 'topic-' + fnv((url || location.href) + '\n' + text)
}
const classify = (text) => {
  const normalized = text.toLocaleLowerCase()
  if (excludeKeywords.some((entry) => normalized.includes(entry))) {
    return 'skipped'
  }
  if (
    includeKeywords.length === 0 &&
    includeRegexes.length === 0
  ) {
    return 'matched'
  }
  return includeKeywords.some((entry) => normalized.includes(entry)) ||
    includeRegexes.some((regex) => regex.test(text))
    ? 'matched'
    : 'skipped'
}
const publishedAt = (element) => {
  const value = element.querySelector('time[datetime]')?.getAttribute('datetime')
  if (!value || Number.isNaN(Date.parse(value))) {
    return null
  }
  return new Date(value).toISOString()
}
const audioLinks = (root) =>
  queryAll(root, audioSelectors)
    .map((element) => {
      const raw =
        element.getAttribute('href') ||
        element.getAttribute('src') ||
        element.querySelector('source[src]')?.getAttribute('src') ||
        ''
      const sourceUrl = absoluteUrl(raw)
      if (!sourceUrl) {
        return null
      }
      const attachmentId =
        element.getAttribute('data-attachment-id') ||
        element.getAttribute('data-file-id') ||
        sourceUrl
      let fileName = ''
      try {
        fileName = decodeURIComponent(
          new URL(sourceUrl).pathname.split('/').filter(Boolean).at(-1) || ''
        )
      } catch {
        fileName = ''
      }
      if (!fileName.toLocaleLowerCase().endsWith('.mp3')) {
        fileName = (fileName || 'meeting-audio') + '.mp3'
      }
      return { sourceUrl, attachmentId, fileName }
    })
    .filter(Boolean)
const downloadButtons = (root) =>
  queryAll(root, downloadButtonSelectors)
    .map((element) => {
      const container =
        element.closest(
          '[data-file-id], app-file-gallery, .file-gallery, .file-item'
        ) || element.parentElement
      const fileName = (
        element.getAttribute('data-file-name') ||
        container?.getAttribute('data-file-name') ||
        container?.querySelector('.file-name')?.textContent ||
        ''
      ).trim()
      if (!fileName.toLocaleLowerCase().endsWith('.mp3')) {
        return null
      }
      const attachmentId =
        element.getAttribute('data-file-id') ||
        container?.getAttribute('data-file-id') ||
        'file-' + fnv(fileName)
      return { element, attachmentId, fileName }
    })
    .filter(Boolean)
const reserveDownloads = async (businessItemId, links, buttons) => {
  const actions = []
  let waiting = false
  for (const audio of links) {
    const reservation = await agenticStrategy.emit('download.intent', {
      businessItemId,
      attachmentId: audio.attachmentId,
      sourceUrl: audio.sourceUrl,
      fileName: audio.fileName,
      mime: 'audio/mpeg'
    })
    if (reservation.kind === 'duplicate') {
      continue
    }
    if (
      reservation.kind === 'in-progress' &&
      reservation.canStart !== true
    ) {
      waiting = true
      continue
    }
    actions.push({ kind: 'url', audio })
  }
  for (const button of buttons) {
    const reservation = await agenticStrategy.emit('download.intent', {
      businessItemId,
      attachmentId: button.attachmentId,
      sourceUrl: location.href,
      fileName: button.fileName,
      mime: 'audio/mpeg'
    })
    if (reservation.kind === 'duplicate') {
      continue
    }
    if (
      reservation.kind === 'in-progress' &&
      reservation.canStart !== true
    ) {
      waiting = true
      continue
    }
    actions.push({ kind: 'button', button })
  }
  return { actions, waiting }
}
const startDownloads = async (actions) => {
  for (const action of actions) {
    if (action.kind === 'button') {
      action.button.element.click()
    } else {
      const link = document.createElement('a')
      link.href = action.audio.sourceUrl
      link.download = action.audio.fileName
      link.hidden = true
      document.body.append(link)
      link.click()
      link.remove()
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

const bodyText = document.body?.innerText || ''
if (
  location.pathname.includes('/login') ||
  (
    bodyText.includes('登录知识星球') &&
    bodyText.includes('获取登录二维码')
  )
) {
  await agenticStrategy.emit('project.authentication-required', {
    reason: '知识星球登录失效，请完成人工登录后恢复自动化',
    href: location.href
  })
  return
}

let pending = null
try {
  pending = JSON.parse(sessionStorage.getItem(pendingKey) || 'null')
} catch {
  sessionStorage.removeItem(pendingKey)
}
if (
  pending &&
  typeof pending === 'object' &&
  typeof pending.detailUrl === 'string' &&
  absoluteUrl(pending.detailUrl) !== absoluteUrl(location.href)
) {
  sessionStorage.removeItem(pendingKey)
  pending = null
}
if (pending && typeof pending === 'object') {
  const links = audioLinks(document)
  const buttons = downloadButtons(document)
  if (links.length === 0 && buttons.length === 0) {
    await agenticStrategy.emit('knowledge.page-changed', {
      reason:
        '进入帖子详情后未找到 MP3，需检查 audioSelectors/downloadButtonSelectors',
      href: location.href,
      businessItemId: pending.businessItemId
    })
    return
  }
  const batch = await reserveDownloads(
    pending.businessItemId,
    links,
    buttons
  )
  sessionStorage.removeItem(pendingKey)
  if (batch.actions.length > 0) {
    await startDownloads(batch.actions)
    return
  }
  if (batch.waiting) {
    return
  }
  await agenticStrategy.emit('download.completed', {
    synthetic: true,
    reason: 'no-new-audio'
  })
  return
}

const elements = queryAll(document, itemSelectors).slice(0, maximumItems)
const candidates = []
for (const element of elements) {
  const text = itemText(element)
  const url = detailUrl(element) || location.href
  const businessItemId = itemId(element, text, url)
  const classification = classify(text)
  const links = audioLinks(element)
  const buttons = downloadButtons(element)
  const observation = await agenticStrategy.emit(
    'project.item-observed',
    {
      businessItemId,
      sourceUrl: url,
      text,
      classification,
      attachmentCount: links.length + buttons.length,
      publishedAt: publishedAt(element),
      metadata: {
        href: location.href,
        detailUrl: url,
        directAudioCount: links.length,
        downloadButtonCount: buttons.length
      }
    }
  )
  if (classification === 'matched') {
    candidates.push({
      businessItemId,
      text,
      detailUrl: url,
      links,
      buttons,
      observation
    })
  }
}

const downloadsToStart = []
let waitingForExistingDownload = false
let detailCandidate = null
for (const candidate of candidates) {
  const batch = await reserveDownloads(
    candidate.businessItemId,
    candidate.links,
    candidate.buttons
  )
  downloadsToStart.push(...batch.actions)
  waitingForExistingDownload ||= batch.waiting
  if (
    candidate.links.length === 0 &&
    candidate.buttons.length === 0 &&
    candidate.detailUrl !== location.href &&
    detailCandidate === null
  ) {
    detailCandidate = candidate
  }
}

if (downloadsToStart.length > 0) {
  await startDownloads(downloadsToStart)
  return
}
if (waitingForExistingDownload) {
  return
}
if (detailCandidate) {
  sessionStorage.setItem(
    pendingKey,
    JSON.stringify({
      businessItemId: detailCandidate.businessItemId,
      text: detailCandidate.text,
      detailUrl: detailCandidate.detailUrl
    })
  )
  location.assign(detailCandidate.detailUrl)
  return
}

await agenticStrategy.emit('knowledge.scan-completed', {
  scanned: elements.length,
  matched: candidates.length,
  downloadStarted: false
})
await agenticStrategy.emit('download.completed', {
  synthetic: true,
  reason: candidates.length === 0
    ? 'no-matching-item'
    : 'no-new-audio'
})
await agenticStrategy.log('knowledge planet scan completed', {
  scanned: elements.length,
  matched: candidates.length
})
`
