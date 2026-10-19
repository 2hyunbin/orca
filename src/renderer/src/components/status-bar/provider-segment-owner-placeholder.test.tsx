import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/lib/agent-catalog', () => ({ AgentIcon: () => null }))
vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { usagePercentageDisplay: 'used' }) => unknown) =>
    selector({ usagePercentageDisplay: 'used' })
}))

const { ProviderSegment } = await import('./StatusBarProviderSegment')

const placeholder: ProviderRateLimits = {
  provider: 'minimax',
  session: null,
  weekly: null,
  updatedAt: 0,
  error: 'Not set up on devbox',
  status: 'error',
  usageMetadata: { ownerNotSetUp: { keySavedHereOnly: true } }
}

describe('ProviderSegment owner placeholder', () => {
  it('renders greyed like an unavailable provider, with the host in its tooltip', () => {
    const markup = renderToStaticMarkup(
      <ProviderSegment p={placeholder} compact={false} display="used" />
    )
    expect(markup).toContain('text-muted-foreground/50')
    expect(markup).toContain(
      'title="Not set up on devbox\nIts key is saved on this computer only."'
    )
    // Why: a placeholder is not a failure, so no warning glyph or refresh-failed copy.
    expect(markup).not.toContain('lucide-triangle-alert')
    expect(markup).not.toContain('Refresh failed')
  })
})
