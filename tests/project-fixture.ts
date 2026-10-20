import { join } from 'node:path'

import { createCapabilityPolicy } from '../src/main/capability-store'
import type {
  ProjectDefinition,
  ProjectStrategyPin
} from '../src/shared/contracts'

export function createProjectDefinition(
  strategies: ProjectStrategyPin[] = [{ id: 'scanner', version: '1.2.3' }]
): ProjectDefinition {
  return {
    id: 'test-project',
    name: 'Test Project',
    revision: 1,
    profileId: 'profile-default',
    startupPages: ['https://example.com/'],
    strategies,
    runtime: {
      mode: 'manual',
      timezone: 'Asia/Shanghai',
      priority: 0,
      maxRunMs: 60_000
    },
    workflow: {
      version: 1,
      entryNodeId: 'open',
      nodes: [
        {
          id: 'open',
          kind: 'navigate',
          url: 'https://example.com/',
          next: 'done',
          timeoutMs: 10_000,
          maxAttempts: 2,
          checkpoint: true
        },
        {
          id: 'done',
          kind: 'complete',
          timeoutMs: 1_000,
          maxAttempts: 1,
          checkpoint: true
        }
      ]
    },
    output: {
      root: join(process.cwd(), 'project-test-output'),
      maxBytes: 1024 * 1024,
      fileNameTemplate: '{fileName}'
    },
    capabilities: createCapabilityPolicy(),
    filter: {
      enabled: false,
      networkRules: [],
      cssRules: []
    },
    retry: {
      maxConsecutiveFailures: 3,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000
    },
    enabled: true,
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:01:00.000Z'
  }
}
