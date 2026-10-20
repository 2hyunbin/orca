// A terminal named only on its tab (an older session, or an unvisited SSH tab's relay session):
// with main owning the layout, the Loader binds it to the tab's one unbound pane, as the window's
// reconnect rebinds it, so main's frames and saves hold it before the pane mounts.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../execution-host'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import { loadWorkspaceLayout } from './workspace-layout-load'
import { checkLayoutRoundTrip } from './workspace-layout-round-trip-check'
import { saveWorkspaceLayout } from './workspace-layout-save'
import {
  addWorkspace,
  emptySession,
  FOLDER_KEY,
  GIT_KEY,
  leaf,
  SSH_KEY
} from './workspace-layout-session.test-fixture'

const layoutOwner = vi.hoisted(() => ({ isMain: true }))
vi.mock('../layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))

const SSH_HOST: ExecutionHostId = 'ssh:box'

/** One tab whose saved pane binds nothing; its terminal is named on the row only. */
function tabLevelSession(
  key: string,
  hostId: ExecutionHostId = LOCAL_EXECUTION_HOST_ID,
  leafIds: string[] = [leaf(1)]
): WorkspaceSessionState {
  const session = addWorkspace(
    emptySession(),
    key,
    [{ id: 'g1', tabs: [{ id: 'tab-a', leaves: leafIds.map((id): [string] => [id]) }] }],
    hostId
  )
  session.tabsByWorktree[key]![0]!.ptyId = 'pty-a'
  session.activeWorktreeIdsOnShutdown = [key]
  return session
}

function load(hostId: ExecutionHostId, session: WorkspaceSessionState) {
  expect(checkLayoutRoundTrip(hostId, session).findings).toEqual([])
  let next = 0
  return loadWorkspaceLayout(hostId, session, {
    mintId: () => `minted-${++next}`,
    mintLeafId: () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`
  })
}

const paneTerminal = (loaded: ReturnType<typeof load>, key: string, leafId = leaf(1)) =>
  loaded.layout.workspaces[key]?.leaves?.[leafId]?.ptyId

describe("Loader: a tab's own terminal and its unbound pane", () => {
  beforeEach(() => {
    layoutOwner.isMain = true
  })

  it.each<[string, ExecutionHostId, string]>([
    ['git worktree', LOCAL_EXECUTION_HOST_ID, GIT_KEY],
    ['folder workspace', LOCAL_EXECUTION_HOST_ID, FOLDER_KEY],
    ['SSH workspace', SSH_HOST, SSH_KEY]
  ])('binds it to the one pane in a %s, and the save keeps it', (_name, hostId, key) => {
    const loaded = load(hostId, tabLevelSession(key, hostId))
    expect(paneTerminal(loaded, key)).toBe('pty-a')
    const saved = saveWorkspaceLayout(loaded)
    expect(saved.terminalLayoutsByTabId['tab-a']?.ptyIdsByLeafId).toEqual({ [leaf(1)]: 'pty-a' })
    expect(saved.tabsByWorktree[key]![0]!.ptyId).toBe('pty-a')
  })

  it("takes an SSH tab's relay session id, which reconnect prefers over the row's", () => {
    const stored = tabLevelSession(SSH_KEY, SSH_HOST)
    stored.tabsByWorktree[SSH_KEY]![0]!.ptyId = null
    stored.remoteSessionIdsByTabId = { 'tab-a': 'ssh:box@@pty-9' }
    expect(paneTerminal(load(SSH_HOST, stored), SSH_KEY)).toBe('ssh:box@@pty-9')
  })

  it('keeps the terminal the pane already binds', () => {
    const stored = tabLevelSession(GIT_KEY)
    stored.terminalLayoutsByTabId['tab-a']!.ptyIdsByLeafId = { [leaf(1)]: 'pty-pane' }
    expect(paneTerminal(load(LOCAL_EXECUTION_HOST_ID, stored), GIT_KEY)).toBe('pty-pane')
  })

  it('binds nothing in a workspace that was not live at shutdown, as reconnect skips it', () => {
    const stored = tabLevelSession(GIT_KEY)
    stored.activeWorktreeIdsOnShutdown = []
    expect(paneTerminal(load(LOCAL_EXECUTION_HOST_ID, stored), GIT_KEY)).toBeUndefined()
  })

  it('reads a session without a shutdown list as live where a row names a terminal', () => {
    const stored = tabLevelSession(GIT_KEY)
    delete stored.activeWorktreeIdsOnShutdown
    expect(paneTerminal(load(LOCAL_EXECUTION_HOST_ID, stored), GIT_KEY)).toBe('pty-a')
  })

  it('leaves a split tab unbound: which pane the window gives it depends on mount order', () => {
    const stored = tabLevelSession(GIT_KEY, LOCAL_EXECUTION_HOST_ID, [leaf(1), leaf(2)])
    const loaded = load(LOCAL_EXECUTION_HOST_ID, stored)
    expect(paneTerminal(loaded, GIT_KEY, leaf(1))).toBeUndefined()
    expect(paneTerminal(loaded, GIT_KEY, leaf(2))).toBeUndefined()
  })

  it("skips a legacy row's terminal a tab-bar tab holds, and binds the row's own (#10486)", () => {
    const stored = addWorkspace(emptySession(), GIT_KEY, [
      { id: 'g1', tabs: [{ id: 'tab-b', leaves: [[leaf(2), 'pty-shared']] }] }
    ])
    // A row outside the tab bar naming the tab-bar tab's terminal and one of its own.
    stored.tabsByWorktree[GIT_KEY]!.push({
      ...stored.tabsByWorktree[GIT_KEY]![0]!,
      id: 'tab-a',
      ptyId: 'pty-own',
      sortOrder: 1
    })
    stored.remoteSessionIdsByTabId = { 'tab-a': 'pty-shared' }
    stored.terminalLayoutsByTabId['tab-a'] = {
      root: { type: 'leaf', leafId: leaf(1) },
      activeLeafId: leaf(1),
      expandedLeafId: null
    }
    stored.activeWorktreeIdsOnShutdown = [GIT_KEY]
    const loaded = load(LOCAL_EXECUTION_HOST_ID, stored)
    expect(paneTerminal(loaded, GIT_KEY, leaf(2))).toBe('pty-shared')
    expect(paneTerminal(loaded, GIT_KEY, leaf(1))).toBe('pty-own')
  })

  it('binds nothing while the window owns the layout', () => {
    layoutOwner.isMain = false
    const loaded = load(LOCAL_EXECUTION_HOST_ID, tabLevelSession(GIT_KEY))
    expect(paneTerminal(loaded, GIT_KEY)).toBeUndefined()
  })
})
