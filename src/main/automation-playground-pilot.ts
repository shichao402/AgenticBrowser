import type {
  ProjectDraft,
  ProjectRuntimeMode,
  StrategyDraft
} from '../shared/contracts'
import { createCapabilityPolicy } from './capability-store'

export const AUTOMATION_PLAYGROUND_ROOT =
  'https://www.selenium.dev/selenium/web'
export const AUTOMATION_PLAYGROUND_FORM_URL = `${AUTOMATION_PLAYGROUND_ROOT}/web-form.html`
export const AUTOMATION_PLAYGROUND_DYNAMIC_URL = `${AUTOMATION_PLAYGROUND_ROOT}/dynamic.html`
export const AUTOMATION_PLAYGROUND_DOWNLOAD_URL = `${AUTOMATION_PLAYGROUND_ROOT}/downloads/download.html`
export const AUTOMATION_PLAYGROUND_MISSING_URL = `${AUTOMATION_PLAYGROUND_ROOT}/agentic-browser-missing-page.html`
export const AUTOMATION_PLAYGROUND_DOWNLOAD_FILE_URL = `${AUTOMATION_PLAYGROUND_ROOT}/downloads/file_1.txt`
export const AUTOMATION_PLAYGROUND_SECOND_SITE_URL =
  'https://testpages.eviltester.com/challenges/synchronization/dynamic-buttons-01/'
export const AUTOMATION_PLAYGROUND_PROJECT_ID = 'selenium-automation-playground'
export const AUTOMATION_PLAYGROUND_STRATEGY_ID = 'selenium-automation-smoke'
export const AUTOMATION_PLAYGROUND_STRATEGY_VERSION = '0.1.0'

export interface AutomationPlaygroundProjectOptions {
  profileId: string
  outputRoot: string
  entryUrl?: string
  runtimeMode?: Extract<ProjectRuntimeMode, 'manual' | 'resident'>
  enabled?: boolean
  maxRunMs?: number
}

export function createAutomationPlaygroundStrategyDraft(): StrategyDraft {
  return {
    manifest: {
      id: AUTOMATION_PLAYGROUND_STRATEGY_ID,
      name: '公开站点自动化验收',
      version: AUTOMATION_PLAYGROUND_STRATEGY_VERSION,
      matches: [
        `${AUTOMATION_PLAYGROUND_ROOT}/*`,
        `${AUTOMATION_PLAYGROUND_SECOND_SITE_URL}*`
      ],
      excludes: [],
      runAt: 'document-idle',
      frames: 'top',
      permissions: [
        'dom.read',
        'dom.write',
        'dom.click',
        'log',
        'project.emit-event'
      ],
      networkMatches: [],
      config: {},
      timeouts: {
        startupMs: 15_000,
        heartbeatMs: 30_000
      }
    },
    source: AUTOMATION_PLAYGROUND_STRATEGY_SOURCE,
    enabled: true
  }
}

export function createAutomationPlaygroundProjectDraft(
  options: AutomationPlaygroundProjectOptions
): ProjectDraft {
  const entryUrl = options.entryUrl ?? AUTOMATION_PLAYGROUND_FORM_URL
  return {
    id: AUTOMATION_PLAYGROUND_PROJECT_ID,
    name: '公开站点自动化验收',
    profileId: options.profileId,
    startupPages: [entryUrl],
    strategies: [
      {
        id: AUTOMATION_PLAYGROUND_STRATEGY_ID,
        version: AUTOMATION_PLAYGROUND_STRATEGY_VERSION
      }
    ],
    runtime: {
      mode: options.runtimeMode ?? 'manual',
      timezone: 'Asia/Shanghai',
      priority: 10,
      maxRunMs: options.maxRunMs ?? 90_000
    },
    workflow: {
      version: 1,
      entryNodeId: 'open-form',
      nodes: [
        {
          id: 'open-form',
          kind: 'navigate',
          url: entryUrl,
          next: 'wait-form',
          timeoutMs: 30_000,
          maxAttempts: 3,
          checkpoint: true
        },
        {
          id: 'wait-form',
          kind: 'wait-for-event',
          eventName: 'playground.form.completed',
          next: 'open-dynamic',
          timeoutMs: 30_000,
          maxAttempts: 2,
          checkpoint: true
        },
        {
          id: 'open-dynamic',
          kind: 'navigate',
          url: AUTOMATION_PLAYGROUND_DYNAMIC_URL,
          next: 'wait-dynamic',
          timeoutMs: 30_000,
          maxAttempts: 3,
          checkpoint: true
        },
        {
          id: 'wait-dynamic',
          kind: 'wait-for-event',
          eventName: 'playground.dynamic.completed',
          next: 'open-download',
          timeoutMs: 30_000,
          maxAttempts: 2,
          checkpoint: true
        },
        {
          id: 'open-download',
          kind: 'navigate',
          url: AUTOMATION_PLAYGROUND_DOWNLOAD_URL,
          next: 'wait-download',
          timeoutMs: 30_000,
          maxAttempts: 3,
          checkpoint: true
        },
        {
          id: 'wait-download',
          kind: 'wait-for-event',
          eventName: 'download.completed',
          next: 'open-second-site',
          timeoutMs: 30_000,
          maxAttempts: 2,
          checkpoint: true
        },
        {
          id: 'open-second-site',
          kind: 'navigate',
          url: AUTOMATION_PLAYGROUND_SECOND_SITE_URL,
          next: 'wait-second-site',
          timeoutMs: 30_000,
          maxAttempts: 3,
          checkpoint: true
        },
        {
          id: 'wait-second-site',
          kind: 'wait-for-event',
          eventName: 'playground.second-site.completed',
          next: 'finished',
          timeoutMs: 45_000,
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
      maxBytes: 100 * 1024 ** 2,
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
      maxBackoffMs: 30_000
    },
    enabled: options.enabled ?? false
  }
}

export const AUTOMATION_PLAYGROUND_STRATEGY_SOURCE = String.raw`
const marker = 'AgenticBrowser real-site smoke'
const emitObservation = (businessItemId, text, attachmentCount = 0) =>
  agenticStrategy.emit('project.item-observed', {
    businessItemId,
    sourceUrl: location.href,
    text,
    classification: 'matched',
    attachmentCount,
    metadata: {
      pathname: location.pathname,
      title: document.title
    }
  })
const reportPageChanged = (reason) =>
  agenticStrategy.emit('project.page-changed', {
    reason,
    href: location.href
  })
const setValue = (element, value) => {
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}
const waitUntil = async (predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

if (location.pathname.endsWith('/web-form.html')) {
  const text = document.querySelector('[name="my-text"]')
  const textarea = document.querySelector('[name="my-textarea"]')
  const select = document.querySelector('[name="my-select"]')
  const checkbox = document.querySelector('#my-check-2')
  const submit = document.querySelector('button[type="submit"]')
  if (!text || !textarea || !select || !checkbox || !submit) {
    await reportPageChanged('Selenium 表单结构变化，缺少预期控件')
    return
  }
  setValue(text, marker)
  setValue(textarea, 'No account, no user data, GET-only validation.')
  setValue(select, '2')
  if (!checkbox.checked) {
    checkbox.click()
  }
  if (
    text.value !== marker ||
    textarea.value.length === 0 ||
    select.value !== '2' ||
    !checkbox.checked
  ) {
    await reportPageChanged('Selenium 表单控件状态未达到预期')
    return
  }
  submit.click()
  return
}

if (location.pathname.endsWith('/submitted-form.html')) {
  const query = new URLSearchParams(location.search)
  const received = document.body?.textContent?.includes('Received!') === true
  if (
    !received ||
    query.get('my-text') !== marker ||
    query.get('my-select') !== '2' ||
    !query.getAll('my-check').length
  ) {
    await reportPageChanged('Selenium 表单提交结果与预期不一致')
    return
  }
  await emitObservation(
    'selenium-form',
    '真实站点表单填写、下拉、复选框和 GET 提交通过'
  )
  await agenticStrategy.emit('playground.form.completed', {
    marker,
    select: query.get('my-select'),
    checkboxCount: query.getAll('my-check').length
  })
  return
}

if (location.pathname.endsWith('/dynamic.html')) {
  const adder = document.querySelector('#adder')
  const reveal = document.querySelector('#reveal')
  const revealed = document.querySelector('#revealed')
  if (!adder || !reveal || !revealed) {
    await reportPageChanged('Selenium 动态页面结构变化')
    return
  }
  if (!document.querySelector('#box0')) {
    adder.click()
  }
  if (getComputedStyle(revealed).display === 'none') {
    reveal.click()
  }
  const ready = await waitUntil(
    () =>
      Boolean(document.querySelector('#box0')) &&
      getComputedStyle(revealed).display !== 'none',
    5_000
  )
  if (!ready) {
    await reportPageChanged('Selenium 延迟元素未在预算内出现')
    return
  }
  setValue(revealed, marker)
  await emitObservation(
    'selenium-dynamic',
    '真实站点延迟 DOM、等待和输入通过'
  )
  await agenticStrategy.emit('playground.dynamic.completed', {
    boxPresent: Boolean(document.querySelector('#box0')),
    revealedValue: revealed.value
  })
  return
}

if (location.pathname.endsWith('/downloads/download.html')) {
  const fileLink = [...document.querySelectorAll('a')].find(
    (anchor) => new URL(anchor.href, location.href).pathname.endsWith(
      '/downloads/file_1.txt'
    )
  )
  if (!fileLink) {
    await reportPageChanged('Selenium 下载页缺少 file_1.txt')
    return
  }
  await emitObservation(
    'selenium-download',
    '真实站点受控文件下载',
    1
  )
  const sourceUrl = new URL(fileLink.href, location.href).toString()
  const reservation = await agenticStrategy.emit('download.intent', {
    businessItemId: 'selenium-download',
    attachmentId: 'file_1.txt',
    sourceUrl,
    fileName: 'selenium-file-1.txt',
    mime: 'text/plain',
    expectedBytes: 14
  })
  if (
    reservation.kind === 'reserved' ||
    (reservation.kind === 'in-progress' && reservation.canStart === true)
  ) {
    const link = document.createElement('a')
    link.href = sourceUrl
    link.download = 'selenium-file-1.txt'
    link.hidden = true
    document.body.append(link)
    link.click()
    link.remove()
    return
  }
  if (reservation.kind === 'duplicate') {
    await agenticStrategy.emit('download.completed', {
      synthetic: true,
      reason: 'already-downloaded',
      downloadId: reservation.downloadId
    })
  }
  return
}

if (
  location.hostname === 'testpages.eviltester.com' &&
  location.pathname.endsWith(
    '/challenges/synchronization/dynamic-buttons-01/'
  )
) {
  const buttonIds = ['button00', 'button01', 'button02', 'button03']
  for (const buttonId of buttonIds) {
    const available = await waitUntil(
      () => document.getElementById(buttonId) instanceof HTMLButtonElement,
      10_000
    )
    const button = document.getElementById(buttonId)
    if (!available || !(button instanceof HTMLButtonElement)) {
      await reportPageChanged(
        'Test Pages 动态按钮未在预算内出现：' + buttonId
      )
      return
    }
    button.click()
  }
  const completed = await waitUntil(
    () =>
      document.querySelector('#buttonmessage')?.textContent?.trim() ===
      'All Buttons Clicked',
    10_000
  )
  if (!completed) {
    await reportPageChanged('Test Pages 动态按钮完成断言失败')
    return
  }
  await emitObservation(
    'testpages-dynamic-buttons',
    '第二公开站点的四阶段延迟按钮同步通过'
  )
  await agenticStrategy.emit('playground.second-site.completed', {
    message: document.querySelector('#buttonmessage')?.textContent?.trim(),
    buttonCount: buttonIds.length
  })
  return
}

await reportPageChanged(
  '公开站点自动化验收进入未声明页面：' +
    location.hostname +
    location.pathname
)
`
