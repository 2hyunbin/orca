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
  usageMetadata: { ownerNotSetUp: { signInSavedHereOnly: true } }
}

describe('ProviderSegment owner placeholder', () => {
  it('labels the chip "Not set up", with the host in its tooltip and no warning glyph', () => {
    const markup = renderToStaticMarkup(
      <ProviderSegment p={placeholder} compact={false} display="used" />
    )
    expect(markup).toContain('>Not set up</span>')
    expect(markup).toContain(
      'title="Not set up on devbox\nIts sign-in is saved on this computer only."'
    )
    // Why: a placeholder is not a failure, so no warning glyph or refresh-failed copy.
    expect(markup).not.toContain('lucide-triangle-alert')
    expect(markup).not.toContain('Refresh failed')
  })

  it('shows "--" instead of the label in compact density, keeping the tooltip', () => {
    const markup = renderToStaticMarkup(<ProviderSegment p={placeholder} compact display="used" />)
    expect(markup).not.toContain('Not set up</span>')
    // Why: an icon alone would read as a healthy chip.
    expect(markup).toContain('--')
    expect(markup).toContain('title="Not set up on devbox')
  })
})
