import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidebarFeedDomains } from '../../../shared/sidebar-list/sidebar-feed-domains'
import { buildWorkspaceRows, type WorkspaceRow } from '../../../shared/sidebar-list/workspace-rows'
import type { Worktree } from '../../../shared/worktree/types'
import {
  makeFolderWorkspace,
  makeRepo,
  makeWorktree
} from '@/components/worktree-jump-palette-test-fixtures'
import { useAppStore } from '@/store'
import type { DesktopSidebarFeed } from './desktop-sidebar-feed'
import { followSidebarFeedSortStamps, patchWorkspaceSortStamps } from './sidebar-feed-sort-stamps'

vi.mock('../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))
const feed = vi.hoisted(() => ({
  followed: 0,
  installListeners: new Set<(installed: DesktopSidebarFeed) => void>()
}))
vi.mock('./desktop-sidebar-feed', () => ({
  followDesktopSidebarFeed: () => {
    feed.followed += 1
  },
  onDesktopSidebarFeedInstalled: (listener: (installed: DesktopSidebarFeed) => void) => {
    feed.installListeners.add(listener)
    return () => feed.installListeners.delete(listener)
  }
}))

const repo = makeRepo()
const a = makeWorktree('repo-1::/w/a', 'a', { hostId: 'local', lastActivityAt: 10 })
const b = makeWorktree('repo-1::/w/b', 'b', { hostId: 'local', lastActivityAt: 20 })

function rowsOf(worktrees: Worktree[]): WorkspaceRow[] {
  return [
    ...buildWorkspaceRows({
      repos: [repo],
      lineageById: {},
      worktrees,
      folderWorkspaces: []
    }).values()
  ]
}

function domains(rows: WorkspaceRow[]): SidebarFeedDomains {
  return {
    workspaces: new Map(rows.map((row) => [`${row.hostId}|${row.id}`, row])),
    activity: new Map(),
    review: new Map(),
    creations: new Map(),
    pairedServerHosts: new Map(),
    pairedServerRows: new Map(),
    repoIcons: new Map(),
    desktop: null,
    projectCatalog: null,
    retention: null
  }
}

function install(rows: WorkspaceRow[]): void {
  feed.installListeners.forEach((listener) => listener({ domains: domains(rows), readId: 1 }))
}

const records = () => useAppStore.getState().worktreesByRepo['repo-1']!

describe('patchWorkspaceSortStamps', () => {
  const state = {
    repos: [repo],
    worktreesByRepo: { 'repo-1': [a, b] },
    folderWorkspaces: [],
    projectGroups: []
  }

  it('writes main’s stamps onto the matching record and keeps every other record', () => {
    const [row] = rowsOf([{ ...a, isUnread: true, lastActivityAt: 99, smartTier: 'done' }])
    const next = patchWorkspaceSortStamps(state, [row!])
    const [patched, untouched] = next.worktreesByRepo!['repo-1']!
    expect(patched).toMatchObject({ isUnread: true, lastActivityAt: 99, smartTier: 'done' })
    expect(patched?.displayName).toBe('a')
    expect(untouched).toBe(b)
  })

  it('leaves the state as it is when the stamps already match', () => {
    expect(patchWorkspaceSortStamps(state, rowsOf([a, b]))).toBe(state)
  })

  it('stamps a folder workspace’s own record', () => {
    const folder = makeFolderWorkspace({ id: 'folder-1', lastActivityAt: 1 })
    const [row] = [
      ...buildWorkspaceRows({
        repos: [],
        lineageById: {},
        worktrees: [],
        folderWorkspaces: [{ ...folder, isUnread: true, lastActivityAt: 7 }]
      }).values()
    ]
    const next = patchWorkspaceSortStamps({ ...state, folderWorkspaces: [folder] }, [row!])
    expect(next.folderWorkspaces?.[0]).toMatchObject({ isUnread: true, lastActivityAt: 7 })
  })
})

describe('followSidebarFeedSortStamps', () => {
  beforeEach(() => {
    feed.installListeners.clear()
    feed.followed = 0
    useAppStore.setState({ repos: [repo], worktreesByRepo: { 'repo-1': [a, b] } })
  })

  it('follows main’s feed with no sidebar list mounted', () => {
    followSidebarFeedSortStamps()
    expect(feed.followed).toBe(1)
  })

  it('takes a stamp main wrote off the next install, with no re-list', () => {
    const detach = followSidebarFeedSortStamps()
    install(rowsOf([a, b]))
    const before = records()
    install(rowsOf([{ ...a, isUnread: true, lastActivityAt: 50 }, b]))
    expect(records()[0]).toMatchObject({ isUnread: true, lastActivityAt: 50 })
    expect(records()[1]).toBe(before[1])
    detach()
  })

  it('keeps the window’s own write while main’s stamps have not moved', () => {
    const detach = followSidebarFeedSortStamps()
    const stale = rowsOf([{ ...a, isUnread: true }, b])
    install(stale)
    // The user marks it read here; main has not answered yet.
    useAppStore.setState({
      worktreesByRepo: { 'repo-1': [{ ...records()[0]!, isUnread: false }, b] }
    })
    install(rowsOf([{ ...a, isUnread: true }, b]))
    expect(records()[0]?.isUnread).toBe(false)
    detach()
  })
})
