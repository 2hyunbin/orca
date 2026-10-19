import { describe, expect, it } from 'vitest'
import { isSettingsNavigationTarget } from './settings-navigation-types'

describe('isSettingsNavigationTarget', () => {
  it('accepts a page-level host scope', () => {
    expect(
      isSettingsNavigationTarget({
        pane: 'accounts',
        repoId: null,
        hostScopeEnvironmentId: 'linux-box'
      })
    ).toBe(true)
  })

  it('rejects a non-string host scope', () => {
    expect(
      isSettingsNavigationTarget({ pane: 'accounts', repoId: null, hostScopeEnvironmentId: 7 })
    ).toBe(false)
  })
})
