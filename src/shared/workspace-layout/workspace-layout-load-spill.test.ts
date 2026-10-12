// #18202: a local worktree's terminal tab saved only in a `runtime:<env>` partition is folded into
// the local partition at load; local's own copy or close record wins.

import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../execution-host'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import { loadWorkspaceLayout } from './workspace-layout-load'
import type { SpilledTerminalTabs } from './workspace-layout-load-spill'
import { nameBasedLoadContext } from './workspace-layout-minted-ids'
import {
  addWorkspace,
  emptySession,
  GIT_KEY,
  leaf,
  SERVER_KEY
} from './workspace-layout-session.test-fixture'

const spillOf = (tabId: string, n: number, ptyId: string, key = GIT_KEY): WorkspaceSessionState => {
  const session = addWorkspace(emptySession(), key, [
    { id: 'spill-group', tabs: [{ id: tabId, leaves: [[leaf(n), ptyId]] }] }
  ])
  session.terminalPtyIncarnationsByPaneKey = { [`${tabId}:${leaf(n)}`]: `${ptyId}-incarnation` }
  return session
}

const local = (): WorkspaceSessionState =>
  addWorkspace(emptySession(), GIT_KEY, [
    { id: 'g1', tabs: [{ id: 'tab-a', leaves: [[leaf(1), 'pty-a']] }] }
  ])

function load(stored: WorkspaceSessionState, sessions: WorkspaceSessionState[]) {
  const spilled: SpilledTerminalTabs = { sessions, ownsKey: (key) => key === GIT_KEY }
  return loadWorkspaceLayout(LOCAL_EXECUTION_HOST_ID, stored, nameBasedLoadContext(), spilled)
}

const tabIdsOf = (loaded: ReturnType<typeof load>, key = GIT_KEY) =>
  loaded.layout.workspaces[key]?.tabs.map((tab) => tab.id)

describe('Loader: spilled terminal tabs (#18202)', () => {
  it('folds a spilled tab into its local worktree with its binding and incarnation', () => {
    const spill = spillOf('tab-s', 2, 'pty-s')
    const before = structuredClone(spill)
    const loaded = load(local(), [spill])

    expect(tabIdsOf(loaded)).toEqual(['tab-a', 'tab-s'])
    expect(loaded.layout.workspaces[GIT_KEY]?.leaves?.[leaf(2)]).toEqual({
      ptyId: 'pty-s',
      incarnationId: 'pty-s-incarnation'
    })
    expect(spill).toEqual(before)
  })

  it("keeps local's copy of a tab both hold, and the first spill partition's of two", () => {
    const stored = local()
    const loaded = load(stored, [
      spillOf('tab-a', 3, 'pty-other'),
      spillOf('tab-s', 2, 'pty-s'),
      spillOf('tab-s', 4, 'pty-late')
    ])

    expect(tabIdsOf(loaded)).toEqual(['tab-a', 'tab-s'])
    const leaves = loaded.layout.workspaces[GIT_KEY]?.leaves
    expect(leaves?.[leaf(1)]?.ptyId).toBe('pty-a')
    expect(leaves?.[leaf(2)]?.ptyId).toBe('pty-s')
    expect(leaves?.[leaf(3)]).toBeUndefined()
    expect(leaves?.[leaf(4)]).toBeUndefined()
  })

  it('folds no tab local closed, and none of a workspace another host owns', () => {
    const stored = local()
    stored.closedTerminalTabTombstonesByTabId = {
      'tab-s': { closedAt: 1, worktreeId: GIT_KEY, reason: 'user' }
    }
    const loaded = load(stored, [
      spillOf('tab-s', 2, 'pty-s'),
      spillOf('tab-x', 5, 'pty-x', SERVER_KEY)
    ])

    expect(tabIdsOf(loaded)).toEqual(['tab-a'])
    expect(loaded.layout.workspaces[SERVER_KEY]).toBeUndefined()
  })

  it('loads as before without spill partitions', () => {
    const stored = local()
    const without = loadWorkspaceLayout(LOCAL_EXECUTION_HOST_ID, stored, nameBasedLoadContext())
    expect(load(stored, [])).toEqual(without)
  })
})
