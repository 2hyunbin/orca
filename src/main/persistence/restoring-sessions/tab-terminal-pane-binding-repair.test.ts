// A terminal named only on its tab (an older session, or an unvisited SSH tab's relay session):
// the load repair binds it to the tab's one unbound pane, as the window's reconnect rebinds it, so
// main's layout, frames and saves hold it before the pane mounts.

import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { loadWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-load'
import { saveWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-save'
import {
  addWorkspace,
  emptySession,
  FOLDER_KEY,
  GIT_KEY,
  leaf,
  SSH_KEY
} from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import {
  bindPersistedTabTerminalPanes,
  bindTabTerminalPanesInSession
} from './tab-terminal-pane-binding-repair'

const SSH_HOST = toSshExecutionHostId('box')

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

const bindings = (session: WorkspaceSessionState, tabId = 'tab-a') =>
  session.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId

describe("load repair: a tab's own terminal and its unbound pane", () => {
  it.each<[string, ExecutionHostId, string]>([
    ['git worktree', LOCAL_EXECUTION_HOST_ID, GIT_KEY],
    ['folder workspace', LOCAL_EXECUTION_HOST_ID, FOLDER_KEY],
    ['SSH workspace', SSH_HOST, SSH_KEY]
  ])('binds it to the one pane in a %s; main loads and saves it bound', (_name, hostId, key) => {
    const repaired = bindTabTerminalPanesInSession(tabLevelSession(key, hostId))
    expect(bindings(repaired)).toEqual({ [leaf(1)]: 'pty-a' })
    let next = 0
    const loaded = loadWorkspaceLayout(hostId, repaired, {
      mintId: () => `minted-${++next}`,
      mintLeafId: () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`
    })
    expect(loaded.layout.workspaces[key]?.leaves?.[leaf(1)]?.ptyId).toBe('pty-a')
    expect(saveWorkspaceLayout(loaded).tabsByWorktree[key]![0]!.ptyId).toBe('pty-a')
  })

  it("takes an SSH tab's relay session id over the row's, as reconnect does", () => {
    const stored = tabLevelSession(SSH_KEY, SSH_HOST)
    stored.remoteSessionIdsByTabId = { 'tab-a': 'ssh:box@@pty-9' }
    expect(bindings(bindTabTerminalPanesInSession(stored))).toEqual({
      [leaf(1)]: 'ssh:box@@pty-9'
    })
  })

  it('keeps the terminal the pane already binds, and returns the session it was given', () => {
    const stored = tabLevelSession(GIT_KEY)
    stored.terminalLayoutsByTabId['tab-a']!.ptyIdsByLeafId = { [leaf(1)]: 'pty-pane' }
    expect(bindTabTerminalPanesInSession(stored)).toBe(stored)
  })

  it('binds nothing in a workspace that was not live at shutdown, as reconnect skips it', () => {
    const stored = tabLevelSession(GIT_KEY)
    stored.activeWorktreeIdsOnShutdown = []
    expect(bindTabTerminalPanesInSession(stored)).toBe(stored)
  })

  it('reads a session without a shutdown list as live where a row names a terminal', () => {
    const stored = tabLevelSession(GIT_KEY)
    delete stored.activeWorktreeIdsOnShutdown
    expect(bindings(bindTabTerminalPanesInSession(stored))).toEqual({ [leaf(1)]: 'pty-a' })
  })

  it('leaves a split tab unbound: which pane the window gives it depends on mount order', () => {
    const stored = tabLevelSession(GIT_KEY, LOCAL_EXECUTION_HOST_ID, [leaf(1), leaf(2)])
    expect(bindTabTerminalPanesInSession(stored)).toBe(stored)
  })

  it("never takes a terminal another tab's pane binds", () => {
    const stored = addWorkspace(emptySession(), GIT_KEY, [
      {
        id: 'g1',
        tabs: [
          { id: 'tab-a', leaves: [[leaf(1)]] },
          { id: 'tab-b', leaves: [[leaf(2), 'pty-a']] }
        ]
      }
    ])
    stored.tabsByWorktree[GIT_KEY]![0]!.ptyId = 'pty-a'
    stored.activeWorktreeIdsOnShutdown = [GIT_KEY]
    expect(bindTabTerminalPanesInSession(stored)).toBe(stored)
  })

  it('ignores a binding a removed pane left behind', () => {
    const stored = tabLevelSession(GIT_KEY)
    stored.terminalLayoutsByTabId['tab-a']!.ptyIdsByLeafId = { [leaf(9)]: 'pty-a' }
    expect(bindings(bindTabTerminalPanesInSession(stored))).toEqual({
      [leaf(9)]: 'pty-a',
      [leaf(1)]: 'pty-a'
    })
  })

  it('binds one of two tabs naming the same terminal, never both', () => {
    const stored = addWorkspace(emptySession(), GIT_KEY, [
      {
        id: 'g1',
        tabs: [
          { id: 'tab-a', leaves: [[leaf(1)]] },
          { id: 'tab-b', leaves: [[leaf(2)]] }
        ]
      }
    ])
    for (const row of stored.tabsByWorktree[GIT_KEY]!) {
      row.ptyId = 'pty-a'
    }
    stored.activeWorktreeIdsOnShutdown = [GIT_KEY]
    const repaired = bindTabTerminalPanesInSession(stored)
    expect(bindings(repaired, 'tab-a')).toEqual({ [leaf(1)]: 'pty-a' })
    expect(bindings(repaired, 'tab-b')?.[leaf(2)]).toBeUndefined()
  })

  it("skips a legacy row's terminal a tab-bar tab holds, and binds the row's own (#10486)", () => {
    const stored = addWorkspace(emptySession(), GIT_KEY, [
      { id: 'g1', tabs: [{ id: 'tab-b', leaves: [[leaf(2)]] }] }
    ])
    stored.tabsByWorktree[GIT_KEY]![0]!.ptyId = 'pty-shared'
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
    const repaired = bindTabTerminalPanesInSession(stored)
    expect(bindings(repaired, 'tab-b')).toEqual({ [leaf(2)]: 'pty-shared' })
    expect(bindings(repaired, 'tab-a')).toEqual({ [leaf(1)]: 'pty-own' })
  })

  it("repairs the local and SSH partitions, and leaves a paired server's as the server keeps it", () => {
    const state = getDefaultPersistedState('/home/dev')
    const runtimeHost = toRuntimeExecutionHostId('env-1')
    const serverSession = tabLevelSession(GIT_KEY)
    state.workspaceSession = tabLevelSession(GIT_KEY)
    state.workspaceSessionsByHostId = {
      [SSH_HOST]: tabLevelSession(SSH_KEY, SSH_HOST),
      [runtimeHost]: serverSession
    }
    const repaired = bindPersistedTabTerminalPanes(state)
    expect(bindings(repaired.workspaceSession)).toEqual({ [leaf(1)]: 'pty-a' })
    expect(bindings(repaired.workspaceSessionsByHostId![SSH_HOST]!)).toEqual({ [leaf(1)]: 'pty-a' })
    expect(repaired.workspaceSessionsByHostId![runtimeHost]).toBe(serverSession)
    expect(bindPersistedTabTerminalPanes(repaired)).toBe(repaired)
  })
})
