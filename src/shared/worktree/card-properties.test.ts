import { describe, expect, it } from 'vitest'
import {
  getWorktreeCardDetails,
  getWorktreeCardModeProperties,
  getWorktreeCardModeUpdates,
  isDefaultedCompactWorktreeCardProperties,
  normalizeWorktreeCardProperties
} from './card-properties'

describe('worktree card properties', () => {
  it('normalizes fixed and legacy properties while preserving selected properties', () => {
    expect(normalizeWorktreeCardProperties(['ci', 'branch', 'pr', 'automation', 'unread'])).toEqual(
      ['status', 'unread', 'ci', 'branch', 'pr', 'automation']
    )
  })

  it('returns combined mode update payloads', () => {
    expect(getWorktreeCardModeUpdates('Compact')).toEqual({
      settings: { compactWorktreeCards: true },
      ui: {
        worktreeCardProperties: getWorktreeCardModeProperties('Compact'),
        _worktreeCardModeDefaulted: true
      }
    })
  })

  it('recognizes only exact defaulted Compact presets', () => {
    expect(isDefaultedCompactWorktreeCardProperties(['status'])).toBe(true)
    expect(isDefaultedCompactWorktreeCardProperties(['status', 'unread'])).toBe(true)
    expect(isDefaultedCompactWorktreeCardProperties(['status', 'automation'])).toBe(true)
    expect(isDefaultedCompactWorktreeCardProperties(['status', 'unread', 'automation'])).toBe(true)
    expect(isDefaultedCompactWorktreeCardProperties(['automation', 'status'])).toBe(false)
    expect(isDefaultedCompactWorktreeCardProperties(['status', 'automation', 'pr'])).toBe(false)
  })
})

describe('getWorktreeCardDetails', () => {
  it('shows each chosen property, and compact classic cards leave out the host and agent rows', () => {
    const chosen = ['pr', 'host', 'inline-agents'] as const
    expect(
      getWorktreeCardDetails(chosen, { compactCards: false, newCardStyle: false })
    ).toMatchObject({ pr: true, host: true, inlineAgents: true, comment: false })
    expect(
      getWorktreeCardDetails(chosen, { compactCards: true, newCardStyle: false })
    ).toMatchObject({ pr: true, host: false, inlineAgents: false })
    // The new card style keeps its agent rows; compactCards is never true with it.
    expect(
      getWorktreeCardDetails(chosen, { compactCards: false, newCardStyle: true }).inlineAgents
    ).toBe(true)
  })
})
