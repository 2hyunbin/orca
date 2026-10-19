import { describe, expect, it } from 'vitest'
import {
  buildSidebarFeedRows,
  type SidebarFeedView
} from '../../../src/shared/sidebar-list/sidebar-feed-rows'
import type { ExecutionHostScope } from '../../../src/shared/execution-host'
import { resolveVisibleWorkspaceHostIds } from '../../../src/shared/workspace-view/workspace-host-visibility'
import { buildHostFeedCatalog, buildHostFeedView } from './host-sidebar-feed-inputs'
import { buildHostFeedSections } from './host-sidebar-feed-sections'
import { SERVED_SECTIONS, feedDomains, liveRow, phoneView } from './host-sidebar-feed.test-fixture'
import type { MobileViewState } from '../worktree/workspace-view-settings'

const catalog = buildHostFeedCatalog(SERVED_SECTIONS, [], [])

function phoneFeedView(view: MobileViewState, showPinnedInGroups = false): SidebarFeedView {
  return buildHostFeedView({
    view,
    projectOrderBy: 'manual',
    desktop: { ...feedDomains().desktop!, showPinnedInGroups },
    hostPlatform: 'darwin'
  })
}

function sectionsFor(
  view: MobileViewState,
  options: {
    showPinnedInGroups?: boolean
    live?: ReturnType<typeof liveRow>[]
    search?: string
  } = {}
) {
  const built = buildSidebarFeedRows(
    feedDomains(),
    catalog,
    phoneFeedView(view, options.showPinnedInGroups)
  )
  return buildHostFeedSections({
    rows: built.sectionRows,
    activeRowKeys: built.activeRowKeys,
    liveRows: options.live ?? [],
    repoHostIdByRepoId: new Map([['lab', 'ssh:gpu']]),
    search: options.search ?? ''
  })
}

function outline(sections: ReturnType<typeof sectionsFor>): string[] {
  return sections.flatMap((section) => [
    `${section.key} "${section.title}" ${String(section.count)}${section.icon ? ' pin' : ''}`,
    ...section.data.map(
      (row) =>
        `  ${row.sectionListKey} depth=${String(row.lineageDepth)}${row.isActive ? ' ACTIVE' : ''}`
    )
  ])
}

describe('the phone list from the sidebar feed', () => {
  it('draws the shared builder’s headers, order, nesting and single highlight', () => {
    const lines = outline(sectionsFor(phoneView()))
    // The pinned parent carries its nested child.
    expect(lines[0]).toMatch(/ "Pinned" 2 pin$/)
    expect(lines.filter((line) => line.endsWith(' ACTIVE'))).toHaveLength(1)
    expect(lines.some((line) => line.includes('orca::/w/child depth=1'))).toBe(true)
    expect(lines.some((line) => line.includes('"lab"'))).toBe(true)
  })

  it('highlights every occurrence when pinned rows also show in their groups', () => {
    const lines = outline(sectionsFor(phoneView(), { showPinnedInGroups: true }))
    expect(lines.filter((line) => line.endsWith(' ACTIVE'))).toHaveLength(2)
  })

  // The phone sends its host list resolved with an "all" scope; the desktop keeps its legacy scope.
  const scopes: [ExecutionHostScope, string[] | null][] = [
    ['ssh:gpu', null],
    ['all', ['local', 'ssh:gpu']],
    ['all', ['ssh:gpu']],
    ['local', ['local', 'ssh:gpu']]
  ]
  it.each(scopes)('builds the desktop’s rows for scope %s and hosts %j', (scope, hostIds) => {
    const visibleHostIds = resolveVisibleWorkspaceHostIds(hostIds, scope)
    const view = phoneView({ filters: { ...phoneView().filters, visibleHostIds } })
    const desktopView: SidebarFeedView = {
      ...phoneFeedView(view),
      workspaceHostScope: scope,
      visibleWorkspaceHostIds: hostIds && hostIds.length > 0 ? visibleHostIds : null
    }
    for (const groupBy of ['repo', 'none', 'workspace-status', 'pr-status'] as const) {
      const phone = buildSidebarFeedRows(
        feedDomains(),
        catalog,
        phoneFeedView({ ...view, groupBy })
      )
      const desktop = buildSidebarFeedRows(feedDomains(), catalog, { ...desktopView, groupBy })
      expect(JSON.stringify(phone.sectionRows)).toBe(JSON.stringify(desktop.sectionRows))
    }
  })

  it('names the desktop’s own host by its platform, not the phone’s', () => {
    const view = phoneView({
      filters: { ...phoneView().filters, visibleHostIds: ['local', 'ssh:gpu'] }
    })
    const built = buildSidebarFeedRows(feedDomains(), catalog, phoneFeedView(view))
    const sections = buildHostFeedSections({
      rows: built.sectionRows,
      activeRowKeys: built.activeRowKeys,
      liveRows: [],
      repoHostIdByRepoId: new Map(),
      search: ''
    })
    expect(sections.map((section) => section.title)).toEqual(
      expect.arrayContaining(['Local Mac', 'GPU box'])
    )
  })

  it('draws each row with the live content worktree.ps served, matched by host', () => {
    const sections = sectionsFor(phoneView(), {
      live: [
        liveRow({ worktreeId: 'orca::/w/child', liveTerminalCount: 2, status: 'working' }),
        liveRow({ worktreeId: 'lab::/w/gpu', hostId: 'ssh:gpu', repoId: 'lab', unread: true })
      ]
    })
    const rows = sections.flatMap((section) => section.data)
    expect(rows.find((row) => row.worktreeId === 'orca::/w/child')).toMatchObject({
      liveTerminalCount: 2,
      status: 'working',
      lineageDepth: 1
    })
    expect(rows.find((row) => row.worktreeId === 'lab::/w/gpu')).toMatchObject({ unread: true })
    // Not listed by worktree.ps yet: drawn from the feed alone.
    expect(rows.find((row) => row.worktreeId === 'orca::/w/parent')).toMatchObject({
      displayName: 'orca::/w/parent',
      liveTerminalCount: 0,
      isPinned: true
    })
  })

  it('never draws one host’s live row under another host’s workspace of the same id', () => {
    const sections = sectionsFor(phoneView(), {
      live: [liveRow({ worktreeId: 'lab::/w/gpu', hostId: 'local', liveTerminalCount: 5 })]
    })
    const remote = sections
      .flatMap((section) => section.data)
      .find((row) => row.worktreeId === 'lab::/w/gpu')
    expect(remote).toMatchObject({ hostId: 'ssh:gpu', liveTerminalCount: 0 })
  })

  it('keeps a collapsed section’s header and count with no rows under it', () => {
    const expanded = sectionsFor(phoneView())
    const lab = expanded.find((section) => section.title === 'lab')!
    const collapsed = sectionsFor(phoneView({ collapsedGroups: [lab.key] }))
    expect(collapsed.find((section) => section.key === lab.key)).toMatchObject({
      count: 1,
      data: []
    })
  })

  it('narrows rows by search and drops sections left with none', () => {
    const sections = sectionsFor(phoneView(), { search: 'gpu' })
    expect(sections.flatMap((section) => section.data.map((row) => row.worktreeId))).toEqual([
      'lab::/w/gpu'
    ])
    expect(sections.map((section) => section.title)).toEqual(['lab'])
  })
})
