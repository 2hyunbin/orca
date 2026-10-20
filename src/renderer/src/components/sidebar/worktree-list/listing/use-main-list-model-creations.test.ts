// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { SidebarFeedDomains } from '../../../../../../shared/sidebar-list/sidebar-feed-domains'
import { withWindowCreations } from './use-main-list-model'

function domainsWith(creations: SidebarFeedDomains['creations']): SidebarFeedDomains {
  return {
    workspaces: new Map(),
    activity: new Map(),
    review: new Map(),
    creations,
    pairedServerHosts: new Map(),
    pairedServerRows: new Map(),
    repoIcons: new Map(),
    desktop: null,
    retention: null
  }
}

describe('withWindowCreations', () => {
  it('lists only the creations the window draws, with main record where main runs one', () => {
    const domains = domainsWith(
      new Map([
        ['ran-here', { repoId: 'repo', worktreeId: 'wt' }],
        // Finished in the window, or started elsewhere: its row would draw an empty gap.
        ['not-here', { repoId: 'repo' }]
      ])
    )
    const listed = withWindowCreations(domains, ['ran-here repo', 'preflight repo'])
    expect([...listed.creations]).toEqual([
      ['ran-here', { repoId: 'repo', worktreeId: 'wt' }],
      ['preflight', { repoId: 'repo' }]
    ])
  })

  it('keeps the same domains when neither side has a creation', () => {
    const domains = domainsWith(new Map())
    expect(withWindowCreations(domains, [])).toBe(domains)
  })
})
