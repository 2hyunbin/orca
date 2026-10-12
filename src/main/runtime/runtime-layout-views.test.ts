import { describe, expect, it } from 'vitest'
import type { PersistedMobileClientTabSelections } from '../../shared/persisted-state-types'
import {
  addWorkspace,
  emptySession,
  GIT_KEY,
  leaf
} from '../../shared/workspace-layout/workspace-layout-session.test-fixture'
import {
  emptyLayoutViewRecord,
  type LayoutViewRecord
} from '../../shared/workspace-layout/workspace-layout-views'
import { RuntimeLayoutViews } from './runtime-layout-views'
import {
  fakeStore,
  gitSession,
  holderFor,
  SERVER_HOST,
  SERVER_KEY,
  SSH_HOST,
  SSH_KEY
} from './runtime-workspace-layouts.test-fixture'

function setup() {
  const store = fakeStore({
    local: gitSession(),
    [SSH_HOST]: addWorkspace(
      emptySession(),
      SSH_KEY,
      [{ id: 'group-h', tabs: [{ id: 'tab-h', leaves: [[leaf(6), 'pty-h']] }] }],
      SSH_HOST
    ),
    [SERVER_HOST]: addWorkspace(emptySession(), SERVER_KEY, [
      { id: 'group-s', tabs: [{ id: 'tab-s', leaves: [[leaf(5), 'pty-s']] }] }
    ])
  })
  let selections: PersistedMobileClientTabSelections = {}
  const runtimeStore = Object.assign(store, {
    getMobileClientTabSelections: () => selections,
    setMobileClientTabSelections: (next: PersistedMobileClientTabSelections) => {
      selections = next
    }
  })
  const { holder } = holderFor(store)
  const views = new RuntimeLayoutViews(holder, () => runtimeStore)
  return { store, holder, views, selections: () => selections }
}

function desktopRecord(): LayoutViewRecord {
  return {
    ...emptyLayoutViewRecord(),
    activeWorktreeId: SSH_KEY,
    activeGroupIdByWorktree: {
      [GIT_KEY]: 'group-a',
      [SSH_KEY]: 'group-h',
      [SERVER_KEY]: 'group-s'
    },
    groups: {
      [GIT_KEY]: { 'group-a': { activeTabId: 'tab-1' } },
      [SSH_KEY]: { 'group-h': { activeTabId: 'tab-h' } }
    },
    panes: { 'tab-1': { activeLeafId: leaf(1), expandedLeafId: null } }
  }
}

describe('RuntimeLayoutViews', () => {
  it("stores the desktop record in each partition's own selection fields and reads it back whole", () => {
    const { store, views } = setup()
    views.setRecord('desktop', desktopRecord())

    expect(store.sessions.local!.activeGroupIdByWorktree).toEqual({ [GIT_KEY]: 'group-a' })
    expect(store.sessions[SSH_HOST]!.activeGroupIdByWorktree).toEqual({ [SSH_KEY]: 'group-h' })
    // Global pointers go to every partition, as the window's split save writes them today.
    expect(store.sessions[SSH_HOST]!.activeWorktreeId).toBe(SSH_KEY)
    expect(store.sessions.local!.terminalLayoutsByTabId['tab-1']?.activeLeafId).toBe(leaf(1))

    const read = views.record('desktop')
    expect(read.activeWorktreeId).toBe(SSH_KEY)
    expect(read.activeGroupIdByWorktree).toEqual(desktopRecord().activeGroupIdByWorktree)
    expect(read.groups).toEqual(desktopRecord().groups)
  })

  it('writes only the view fields of a server partition, leaving its layout to the frozen mirror', () => {
    const { store, views } = setup()
    const serverTabs = store.sessions[SERVER_HOST]!.tabsByWorktree
    views.setRecord('desktop', desktopRecord())
    expect(store.sessions[SERVER_HOST]!.activeGroupIdByWorktree).toEqual({
      [SERVER_KEY]: 'group-s'
    })
    expect(store.sessions[SERVER_HOST]!.tabsByWorktree).toBe(serverTabs)
  })

  it("clears a server partition's selection field the view no longer has", () => {
    const { store, views } = setup()
    const key = `worktree:${SERVER_KEY}` as const
    views.setRecord('desktop', { ...desktopRecord(), activeWorkspaceKey: key })
    expect(store.sessions[SERVER_HOST]!.activeWorkspaceKey).toBe(key)
    views.setRecord('desktop', desktopRecord())
    expect(store.sessions[SERVER_HOST]).not.toHaveProperty('activeWorkspaceKey')
  })

  it('saves nothing when the record did not change', () => {
    const { store, views } = setup()
    views.setRecord('desktop', desktopRecord())
    store.setWorkspaceSession.mockClear()
    views.setRecord('desktop', desktopRecord())
    expect(store.setWorkspaceSession).not.toHaveBeenCalled()
  })

  it("keeps a paired device's record in its selection store, apart from the desktop's", () => {
    const { views, selections } = setup()
    const record: LayoutViewRecord = {
      ...emptyLayoutViewRecord(),
      activeGroupIdByWorktree: { [GIT_KEY]: 'group-a' },
      groups: { [GIT_KEY]: { 'group-a': { activeTabId: 'tab-1' } } }
    }
    views.setRecord('device:phone-1', record)
    expect(selections()).toEqual({
      'phone-1': {
        [GIT_KEY]: {
          activeTabId: 'tab-1',
          activeGroupId: 'group-a',
          activeTabIdByGroupId: { 'group-a': 'tab-1' }
        }
      }
    })
    expect(views.record('device:phone-1')).toMatchObject({
      activeGroupIdByWorktree: record.activeGroupIdByWorktree,
      groups: record.groups
    })
    expect(views.record('device:phone-2').groups).toEqual({})
  })

  it('sends a navigation request only to the views subscribed now', () => {
    const { views } = setup()
    const desktop: unknown[] = []
    const stop = views.onNavigate('desktop', (request) => desktop.push(request))
    const request = { kind: 'revealWorkspace' as const, workspace: GIT_KEY }
    views.navigate('desktop', request)
    views.navigate('device:phone-1', request)
    stop()
    views.navigate('desktop', request)
    expect(desktop).toEqual([request])
  })

  it("saves a pane's reported screen as today's scrollback", () => {
    const { store, views } = setup()
    views.setScrollback(`tab-1:${leaf(1)}`, 'serialized screen')
    expect(store.sessions.local!.terminalLayoutsByTabId['tab-1']?.buffersByLeafId).toEqual({
      [leaf(1)]: 'serialized screen'
    })
  })
})
