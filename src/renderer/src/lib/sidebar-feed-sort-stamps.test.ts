import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidebarFeedDomains } from '../../../shared/sidebar-list/sidebar-feed-domains'
import { buildWorkspaceRows, type WorkspaceRow } from '../../../shared/sidebar-list/workspace-rows'
import type { DetectedWorktreeListResult, Worktree } from '../../../shared/worktree/types'
import {
  makeFolderWorkspace,
  makeRepo,
  makeWorktree
} from '@/components/worktree-jump-palette-test-fixtures'
import { useAppStore } from '@/store'
import type { DesktopSidebarFeed } from './desktop-sidebar-feed'
import type { SidebarPendingLayer } from './sidebar-pending-overlay'
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
const pending = vi.hoisted(() => {
  const layer: SidebarPendingLayer = { writes: [], created: [], removed: [] }
  return { layer, listeners: new Set<() => void>() }
})
vi.mock('./sidebar-pending-layer', () => ({
  readSidebarPendingLayer: () => pending.layer,
  subscribeSidebarPendingLayer: (listener: () => void) => {
    pending.listeners.add(listener)
    return () => pending.listeners.delete(listener)
  }
}))
const NO_PENDING: SidebarPendingLayer = { writes: [], created: [], removed: [] }

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
  const noDetected: Record<string, DetectedWorktreeListResult> = {}
  const state = {
    repos: [repo],
    worktreesByRepo: { 'repo-1': [a, b] },
    detectedWorktreesByRepo: noDetected,
    folderWorkspaces: [],
    projectGroups: []
  }

  it('writes main’s stamps onto the matching record and keeps every other record', () => {
    const rows = rowsOf([{ ...a, isUnread: true, lastActivityAt: 99, smartTier: 'done' }])
    const next = patchWorkspaceSortStamps(state, rows, NO_PENDING)
    const [patched, untouched] = next.worktreesByRepo!['repo-1']!
    expect(patched).toMatchObject({ isUnread: true, lastActivityAt: 99, smartTier: 'done' })
    expect(patched?.displayName).toBe('a')
    expect(untouched).toBe(b)
  })

  it('leaves the state as it is when the stamps already match', () => {
    expect(patchWorkspaceSortStamps(state, rowsOf([a, b]), NO_PENDING)).toBe(state)
  })

  it('stamps the detected listing the Activity page reads', () => {
    const detected: DetectedWorktreeListResult = {
      repoId: 'repo-1',
      authoritative: true,
      source: 'git',
      worktrees: [{ ...a, ownership: 'orca-managed', selectedCheckout: false, visible: true }]
    }
    const next = patchWorkspaceSortStamps(
      { ...state, detectedWorktreesByRepo: { 'repo-1': detected } },
      rowsOf([{ ...a, isUnread: true, lastActivityAt: 70 }]),
      NO_PENDING
    )
    expect(next.detectedWorktreesByRepo?.['repo-1']?.worktrees[0]).toMatchObject({
      isUnread: true,
      lastActivityAt: 70
    })
  })

  it('stamps a folder workspace’s own record', () => {
    const folder = makeFolderWorkspace({ id: 'folder-1', lastActivityAt: 1 })
    const rows = buildWorkspaceRows({
      repos: [],
      lineageById: {},
      worktrees: [],
      folderWorkspaces: [{ ...folder, isUnread: true, lastActivityAt: 7 }]
    }).values()
    const next = patchWorkspaceSortStamps(
      { ...state, folderWorkspaces: [folder] },
      rows,
      NO_PENDING
    )
    expect(next.folderWorkspaces?.[0]).toMatchObject({ isUnread: true, lastActivityAt: 7 })
  })
})

describe('followSidebarFeedSortStamps', () => {
  let detach: () => void = () => {}
  beforeEach(() => {
    feed.installListeners.clear()
    feed.followed = 0
    pending.layer = NO_PENDING
    pending.listeners.clear()
    useAppStore.setState({ repos: [repo], worktreesByRepo: { 'repo-1': [a, b] } })
  })
  afterEach(() => detach())

  it('follows main’s feed with no sidebar list mounted', () => {
    detach = followSidebarFeedSortStamps()
    expect(feed.followed).toBe(1)
  })

  it('takes a stamp main wrote off the next install, with no re-list', () => {
    detach = followSidebarFeedSortStamps()
    install(rowsOf([{ ...a, isUnread: true, lastActivityAt: 50 }, b]))
    expect(records()[0]).toMatchObject({ isUnread: true, lastActivityAt: 50 })
    expect(records()[1]).toBe(b)
  })

  it('heals a listing that read main before the stamp and landed after it', () => {
    detach = followSidebarFeedSortStamps()
    install(rowsOf([{ ...a, isUnread: true, lastActivityAt: 50, smartTier: 'done' }, b]))
    useAppStore.setState({ worktreesByRepo: { 'repo-1': [{ ...a }, b] } })
    expect(records()[0]).toMatchObject({ isUnread: true, lastActivityAt: 50, smartTier: 'done' })
  })

  it('keeps the window’s unanswered mark read until main shows it', () => {
    detach = followSidebarFeedSortStamps()
    pending.layer = {
      ...NO_PENDING,
      writes: [
        { opId: 1, worktreeId: a.id, hostId: null, answeredBy: null, values: { isUnread: false } }
      ]
    }
    install(rowsOf([{ ...a, isUnread: true, lastActivityAt: 50 }, b]))
    expect(records()[0]).toMatchObject({ isUnread: false, lastActivityAt: 50 })
    // The write settles with main still showing unread: main's value stands.
    pending.layer = NO_PENDING
    pending.listeners.forEach((listener) => listener())
    expect(records()[0]?.isUnread).toBe(true)
  })
})
