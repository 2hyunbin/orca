import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

vi.mock('@/lib/agent-catalog', () => ({ AgentIcon: () => null }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import { ProviderPanel } from './tooltip'

function noLogin(claudeAuth?: 'api-key' | 'none'): string {
  const p: ProviderRateLimits = {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: 0,
    status: 'unavailable',
    error: 'No subscription plan — API key billing',
    usageMetadata: { failureKind: 'missing-credentials', ...(claudeAuth ? { claudeAuth } : {}) }
  }
  return renderToStaticMarkup(createElement(ProviderPanel, { p }))
}

describe('ProviderPanel Claude with no login', () => {
  it('says not signed in only when the host found no credential', () => {
    expect(noLogin('none')).toContain('Not signed in to Claude')
    expect(noLogin('none')).not.toContain('API key billing')
  })

  it("keeps the host's API-key copy for a key or an older host", () => {
    expect(noLogin('api-key')).toContain('No subscription plan — API key billing')
    expect(noLogin()).toContain('No subscription plan — API key billing')
  })
})
