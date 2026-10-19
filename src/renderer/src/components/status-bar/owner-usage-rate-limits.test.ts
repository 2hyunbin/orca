import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits, RateLimitState } from '../../../../shared/rate-limit-types'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import { isOwnerNotSetUpPlaceholder, resolveOwnerUsageRateLimits } from './owner-usage-rate-limits'
import {
  getOwnerNotSetUpNote,
  getProviderUsageErrorMessage,
  getProviderUsageStatusLabel
} from './usage-error-copy'
import { isUsageEmptyState } from './status-bar-provider-visibility'

function provider(id: ProviderRateLimits['provider'], usedPercent: number): ProviderRateLimits {
  return {
    provider: id,
    session: { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt: 1,
    error: null,
    status: 'ok'
  }
}

const local = createEmptyRateLimitState({
  claude: provider('claude', 11),
  codex: provider('codex', 22),
  grok: provider('grok', 33),
  grokAuthConfigured: true
})

describe('resolveOwnerUsageRateLimits', () => {
  it('passes local usage through when this device owns the accounts', () => {
    expect(resolveOwnerUsageRateLimits(local, { kind: 'local' })).toBe(local)
  })

  it("shows the remote owner's Claude and Codex usage, not the viewer's", () => {
    const remote = createEmptyRateLimitState({
      claude: provider('claude', 70),
      codex: provider('codex', 80)
    })
    const resolved = resolveOwnerUsageRateLimits(local, {
      kind: 'remote',
      ownerLabel: 'devbox',
      rateLimits: remote
    })
    expect(resolved.claude?.session?.usedPercent).toBe(70)
    expect(resolved.codex?.session?.usedPercent).toBe(80)
    // The viewer's Grok login is not the host's.
    expect(resolved.grok?.session).toBeNull()
    expect(resolved.grokAuthConfigured).toBe(false)
  })

  it('treats providers and flags an older host omits as not configured there', () => {
    const {
      cursor: _cursor,
      zcode: _zcode,
      cursorAuthConfigured: _flag,
      ...older
    } = createEmptyRateLimitState({ claude: provider('claude', 5) })
    // Why: an older host's payload lacks keys the current type requires.
    const rateLimits: RateLimitState = Object.assign(Object.create(null), older)
    const resolved = resolveOwnerUsageRateLimits(
      createEmptyRateLimitState({ claude: provider('claude', 1) }),
      { kind: 'remote', ownerLabel: 'devbox', rateLimits }
    )
    expect(resolved.cursor).toBeNull()
    expect(resolved.zcode).toBeNull()
    expect(resolved.cursorAuthConfigured).toBe(false)
    expect(resolved.claude?.session?.usedPercent).toBe(5)
  })

  it('never renders local percentages while the first remote snapshot is in flight', () => {
    const resolved = resolveOwnerUsageRateLimits(local, { kind: 'remote-pending' })
    for (const key of ['claude', 'codex', 'grok'] as const) {
      expect(resolved[key]?.status).toBe('fetching')
      expect(resolved[key]?.session).toBeNull()
    }
  })

  it('says usage is unavailable when an older host publishes none, without erroring', () => {
    const resolved = resolveOwnerUsageRateLimits(local, {
      kind: 'remote-unverifiable',
      ownerLabel: 'Mac Mini',
      reason: 'usage-not-published',
      lastKnown: null
    })
    const claude = resolved.claude!
    expect(claude.session).toBeNull()
    expect(getProviderUsageStatusLabel(claude)).toBe('Usage unavailable')
    expect(getProviderUsageErrorMessage(claude)).toContain('Mac Mini does not report usage')
  })

  it('keeps the bars an unreachable host vouched for, blanked, and invents none', () => {
    const lastKnown = createEmptyRateLimitState({ codex: provider('codex', 40) })
    const resolved = resolveOwnerUsageRateLimits(local, {
      kind: 'remote-unverifiable',
      ownerLabel: 'devbox',
      reason: 'unreachable',
      lastKnown
    })
    expect(resolved.codex?.session).toBeNull()
    expect(getProviderUsageStatusLabel(resolved.codex!)).toBe('Usage unavailable')
    expect(getProviderUsageErrorMessage(resolved.codex!)).toContain('cannot reach devbox')
    expect(resolved.claude).toBeNull()
    expect(resolved.grok).toBeNull()
  })

  it("never copies the viewer's setup flags into a pending or disconnected remote state", () => {
    const pending = resolveOwnerUsageRateLimits(local, { kind: 'remote-pending' })
    expect(pending.grokAuthConfigured).toBe(false)
    const lastKnown = createEmptyRateLimitState({
      codex: provider('codex', 40),
      cursorAuthConfigured: true
    })
    const lost = resolveOwnerUsageRateLimits(local, {
      kind: 'remote-unverifiable',
      ownerLabel: 'devbox',
      reason: 'unreachable',
      lastKnown
    })
    expect(lost.grokAuthConfigured).toBe(false)
    expect(lost.cursorAuthConfigured).toBe(true)
    const neverAnswered = resolveOwnerUsageRateLimits(local, {
      kind: 'remote-unverifiable',
      ownerLabel: 'devbox',
      reason: 'unreachable',
      lastKnown: null
    })
    expect(neverAnswered.grokAuthConfigured).toBe(false)
    expect(neverAnswered.grok).toBeNull()
    expect(neverAnswered.codex?.status).toBe('error')
  })

  it('stops a slot the host was still fetching from loading through an outage', () => {
    const lastKnown = createEmptyRateLimitState({
      grok: { ...provider('grok', 0), session: null, status: 'fetching' },
      grokAuthConfigured: true
    })
    const lost = resolveOwnerUsageRateLimits(local, {
      kind: 'remote-unverifiable',
      ownerLabel: 'devbox',
      reason: 'unreachable',
      lastKnown
    })
    expect(lost.grok?.status).toBe('error')
  })

  describe('providers set up here but not on the remote owner', () => {
    const remoteOwner = (rateLimits: RateLimitState) =>
      ({ kind: 'remote', ownerLabel: 'devbox', rateLimits }) as const

    it('shows a numberless placeholder that names the host', () => {
      const here = createEmptyRateLimitState({
        minimax: { ...provider('minimax', 64), status: 'error', error: 'invalid key' },
        minimaxApiKeyConfigured: true
      })
      const resolved = resolveOwnerUsageRateLimits(here, remoteOwner(createEmptyRateLimitState()))
      const minimax = resolved.minimax!
      expect(isOwnerNotSetUpPlaceholder(minimax)).toBe(true)
      expect(hasNoNumbers(minimax)).toBe(true)
      expect(minimax.error).toBe('Not set up on devbox')
      expect(getProviderUsageStatusLabel(minimax)).toBe('Not set up')
      expect(getOwnerNotSetUpNote(minimax)).toBe('Its key is saved on this computer only.')
      expect(getProviderUsageErrorMessage(minimax)).toBe(
        'Not set up on devbox\nIts key is saved on this computer only.'
      )
      // Why: the host's setup flags stay the host's.
      expect(resolved.minimaxApiKeyConfigured).toBe(false)
      expect(
        isUsageEmptyState(resolved, {
          ...resolved,
          antigravityUsageConfigured: false
        })
      ).toBe(false)
    })

    it('counts a saved key that has not fetched yet as set up here', () => {
      const here = createEmptyRateLimitState({ zcodePlanApiKeyConfigured: true })
      const resolved = resolveOwnerUsageRateLimits(here, remoteOwner(createEmptyRateLimitState()))
      expect(isOwnerNotSetUpPlaceholder(resolved.zcode!)).toBe(true)
      expect(getOwnerNotSetUpNote(resolved.zcode!)).not.toBeNull()
    })

    it('adds no key note for a sign-in that is not a saved key', () => {
      const resolved = resolveOwnerUsageRateLimits(local, remoteOwner(createEmptyRateLimitState()))
      expect(isOwnerNotSetUpPlaceholder(resolved.grok!)).toBe(true)
      expect(getOwnerNotSetUpNote(resolved.grok!)).toBeNull()
    })

    it("keeps the host's own slot, even while it is loading or failing", () => {
      const remote = createEmptyRateLimitState({
        claude: provider('claude', 70),
        codex: { ...provider('codex', 0), session: null, status: 'fetching' },
        grok: { ...provider('grok', 0), session: null, status: 'error', error: 'offline' }
      })
      const resolved = resolveOwnerUsageRateLimits(local, remoteOwner(remote))
      expect(resolved.claude?.session?.usedPercent).toBe(70)
      expect(resolved.codex?.status).toBe('fetching')
      expect(resolved.grok?.error).toBe('offline')
    })

    it('treats a host flag as set up there, so its pending bar is not replaced', () => {
      const here = createEmptyRateLimitState({ cursorAuthConfigured: true })
      const remote = createEmptyRateLimitState({ cursorAuthConfigured: true })
      const resolved = resolveOwnerUsageRateLimits(here, remoteOwner(remote))
      expect(resolved.cursor).toBeNull()
    })

    it('replaces a slot the host reports unavailable', () => {
      const remote = createEmptyRateLimitState({
        grok: { ...provider('grok', 0), session: null, status: 'unavailable' }
      })
      const resolved = resolveOwnerUsageRateLimits(local, remoteOwner(remote))
      expect(isOwnerNotSetUpPlaceholder(resolved.grok!)).toBe(true)
    })

    it('invents nothing for a provider set up on neither machine', () => {
      const resolved = resolveOwnerUsageRateLimits(local, remoteOwner(createEmptyRateLimitState()))
      expect(resolved.gemini).toBeNull()
      expect(resolved.minimax).toBeNull()
    })

    it('adds no placeholders while the host is pending or unreachable', () => {
      const pending = resolveOwnerUsageRateLimits(local, { kind: 'remote-pending' })
      const lost = resolveOwnerUsageRateLimits(local, {
        kind: 'remote-unverifiable',
        ownerLabel: 'devbox',
        reason: 'unreachable',
        lastKnown: createEmptyRateLimitState()
      })
      for (const resolved of [pending, lost]) {
        for (const key of ['claude', 'codex', 'grok'] as const) {
          expect(resolved[key]?.usageMetadata?.ownerNotSetUp).toBeUndefined()
        }
      }
    })
  })
})

function hasNoNumbers(p: ProviderRateLimits): boolean {
  return !p.session && !p.weekly && !p.monthly && !p.fableWeekly && !p.buckets?.length
}
