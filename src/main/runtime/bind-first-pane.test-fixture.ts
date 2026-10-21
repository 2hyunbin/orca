// Layout-owner builds bind a terminal's pane before they register it (L80): the PTY host's spawn
// commit writes the binding, then registers. Fixtures that register terminals themselves, or fake
// the spawn, stand in for that commit here. Window-owned builds write nothing, as before.
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../../shared/constants'

export type BoundPane = { worktreeId: string; tabId: string; leafId: string; ptyId: string }

type SessionStore = {
  getWorkspaceSession?: (hostId?: string) => WorkspaceSessionState | null | undefined
  setWorkspaceSession?: (session: WorkspaceSessionState, hostId?: string) => void
  getWorkspaceSessionHostIds?: () => readonly string[]
}

function storeOf(runtime: object): SessionStore | null {
  const store: unknown = Reflect.get(runtime, 'store')
  return store && typeof store === 'object' ? store : null
}

function containsLeaf(node: unknown, leafId: string): boolean {
  if (!node || typeof node !== 'object') {
    return false
  }
  return Reflect.get(node, 'type') === 'leaf'
    ? Reflect.get(node, 'leafId') === leafId
    : containsLeaf(Reflect.get(node, 'first'), leafId) ||
        containsLeaf(Reflect.get(node, 'second'), leafId)
}

/** The session with the pane bound to its terminal: the tab and leaf added when missing. */
export function withBoundPane(
  session: WorkspaceSessionState,
  pane: BoundPane
): WorkspaceSessionState {
  const tabs = session.tabsByWorktree[pane.worktreeId] ?? []
  const hasTab = tabs.some((tab) => tab.id === pane.tabId)
  const layout = session.terminalLayoutsByTabId[pane.tabId]
  const leaf = { type: 'leaf' as const, leafId: pane.leafId }
  const root = !layout?.root
    ? leaf
    : containsLeaf(layout.root, pane.leafId)
      ? layout.root
      : { type: 'split' as const, direction: 'vertical' as const, first: layout.root, second: leaf }
  return {
    ...session,
    tabsByWorktree: {
      ...session.tabsByWorktree,
      [pane.worktreeId]: hasTab
        ? tabs
        : [
            ...tabs,
            {
              id: pane.tabId,
              ptyId: pane.ptyId,
              worktreeId: pane.worktreeId,
              title: 'Terminal',
              customTitle: null,
              color: null,
              sortOrder: tabs.length,
              createdAt: 1
            }
          ]
    },
    terminalLayoutsByTabId: {
      ...session.terminalLayoutsByTabId,
      [pane.tabId]: {
        ...layout,
        activeLeafId: layout?.activeLeafId ?? pane.leafId,
        expandedLeafId: layout?.expandedLeafId ?? null,
        root,
        ptyIdsByLeafId: { ...layout?.ptyIdsByLeafId, [pane.leafId]: pane.ptyId }
      }
    }
  }
}

/**
 * As the spawn commit: binds the pane in the runtime's store session before registration. A
 * store with no session gets an in-memory one, as a profile always has. No-op with the switch off.
 */
export function bindPaneFirst(runtime: object, pane: BoundPane, hostId = 'local'): void {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return
  }
  const store = storeOf(runtime)
  if (!store) {
    throw new Error('bindPaneFirst needs a runtime with a store: main binds panes in its layout')
  }
  if (!store.getWorkspaceSession || !store.setWorkspaceSession) {
    let session = getDefaultWorkspaceSession()
    store.getWorkspaceSession = () => session
    store.setWorkspaceSession = (next) => {
      session = next
    }
  }
  store.getWorkspaceSessionHostIds ??= () => [hostId]
  const current = store.getWorkspaceSession(hostId) ?? getDefaultWorkspaceSession()
  store.setWorkspaceSession(withBoundPane(current, pane), hostId)
}

/** registerPty as the PTY host's commit runs it: the pane is bound first. */
export function registerBoundPty(
  runtime: {
    registerPty: (
      ptyId: string,
      worktreeId: string,
      connectionId?: string | null,
      binding?: { tabId: string; leafId: string } & Record<string, unknown>
    ) => void
  },
  ptyId: string,
  worktreeId: string,
  connectionId: string | null,
  binding: { tabId: string; leafId: string } & Record<string, unknown>
): void {
  bindPaneFirst(runtime, { worktreeId, tabId: binding.tabId, leafId: binding.leafId, ptyId })
  runtime.registerPty(ptyId, worktreeId, connectionId, binding)
}

/** A fake PTY host spawn that commits as the real one does: it binds the pane, then answers. */
export function committingSpawn<
  Args extends { worktreeId?: string; tabId?: string; leafId?: string },
  Result extends { id: string }
>(runtime: object, spawn: (args: Args) => Promise<Result>): (args: Args) => Promise<Result> {
  return async (args) => {
    const result = await spawn(args)
    if (args.worktreeId && args.tabId && args.leafId) {
      bindPaneFirst(runtime, {
        worktreeId: args.worktreeId,
        tabId: args.tabId,
        leafId: args.leafId,
        ptyId: result.id
      })
    }
    return result
  }
}
