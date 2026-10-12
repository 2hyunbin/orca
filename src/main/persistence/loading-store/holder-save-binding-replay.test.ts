import { describe, expect, it, vi } from 'vitest'
import { TEST_LEAF_1 } from '../../persistence-session-fixtures'
import { unbindAbsentPane } from '../../runtime/runtime-held-pane-exits'
import { RuntimeWorkspaceLayouts } from '../../runtime/runtime-workspace-layouts'
import { fixture } from './profile-state-delayed-authority-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const WT = 'repo-local::/fixture/local'
const pane = { worktreeId: WT, tabId: 'tab', leafId: TEST_LEAF_1, ptyId: 'dead-pty' }

type Saved = {
  workspaceSession: {
    tabsByWorktree: Record<string, { id: string; ptyId: string | null }[]>
    terminalLayoutsByTabId: Record<string, { ptyIdsByLeafId?: Record<string, string> }>
  }
}

async function boundSinglePaneTab() {
  const { store, readState } = await fixture()
  await store.persistPtyBinding(pane)
  await store.flushPendingOrThrowAsync()
  const saved = (): Saved => readState()
  const ptyIdsOf = (state: Saved) =>
    state.workspaceSession.terminalLayoutsByTabId.tab?.ptyIdsByLeafId ?? {}
  expect(ptyIdsOf(saved())).toEqual({ [TEST_LEAF_1]: 'dead-pty' })
  return { store, saved, ptyIdsOf }
}

describe('the Store binding replay', () => {
  it('does not re-bind a pane the holder unbound when it was its tab’s last binding', async () => {
    const { store, saved, ptyIdsOf } = await boundSinglePaneTab()
    const holder = new RuntimeWorkspaceLayouts({
      store: () => store,
      homeHostId: () => 'local',
      isKnownLocalWorkspace: () => false,
      isFrozenPartition: () => false,
      terminal: () => ({ fact: null }),
      stopTerminals: () => {}
    })
    holder.load()

    expect(unbindAbsentPane(holder, pane)).toBe('kept')
    await store.flushPendingOrThrowAsync()

    expect(ptyIdsOf(saved())).toEqual({})
    const tab = saved().workspaceSession.tabsByWorktree[WT]?.find(({ id }) => id === 'tab')
    expect(tab?.ptyId ?? null).toBeNull()
  })

  it('still restores a binding a window snapshot dropped', async () => {
    const { store, saved, ptyIdsOf } = await boundSinglePaneTab()
    const session = structuredClone(store.getWorkspaceSession())
    session.terminalLayoutsByTabId.tab!.ptyIdsByLeafId = {}

    store.setWorkspaceSession(session)
    await store.flushPendingOrThrowAsync()

    expect(ptyIdsOf(saved())).toEqual({ [TEST_LEAF_1]: 'dead-pty' })
  })
})

describe('a holder save that binds a pane without a topology change', () => {
  it("writes the row's terminal, which the membership rebase keeps for renderer saves", async () => {
    const { store, readState } = await fixture()
    const holder = new RuntimeWorkspaceLayouts({
      store: () => store,
      homeHostId: () => 'local',
      isFrozenPartition: () => false,
      terminal: () => ({ fact: null }),
      stopTerminals: () => {}
    })
    holder.load()
    holder.addCatalogWorkspaces([WT])
    // The create advances the repo's topology revision and saves the row with no terminal yet.
    const created = holder.apply({ type: 'createTerminalTab', workspace: WT })
    const start = created.ok ? created.starts?.[0] : undefined
    expect(start).toBeDefined()

    const started = { workspace: WT, paneKey: start!.paneKey, ptyId: 'live-pty' }
    expect(holder.bindStarted('local', started, start!.attempt)).toBe('bound')
    await store.flushPendingOrThrowAsync()

    const state: Saved = readState()
    const rows = state.workspaceSession.tabsByWorktree[WT] ?? []
    const row = rows.find(({ id }) => start!.paneKey.startsWith(`${id}:`))
    expect(row?.ptyId).toBe('live-pty')
  })
})
