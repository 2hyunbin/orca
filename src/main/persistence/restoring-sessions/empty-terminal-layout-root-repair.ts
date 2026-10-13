import { randomUUID } from 'node:crypto'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { resolveRootlessTerminalLayoutLeafId } from '../../../shared/workspace-layout/terminal-pane-tree'

function nameEmptyLayoutRoot(layout: TerminalLayoutSnapshot): TerminalLayoutSnapshot {
  if (layout.root) {
    return layout
  }
  // Same pane the window would mount for this layout, so an existing binding keeps its leaf.
  const leafId = resolveRootlessTerminalLayoutLeafId(layout) ?? randomUUID()
  return { ...layout, root: { type: 'leaf', leafId }, activeLeafId: leafId, expandedLeafId: null }
}

function nameEmptyLayoutRootsInSession(session: WorkspaceSessionState): WorkspaceSessionState {
  const layouts = session.terminalLayoutsByTabId
  if (!layouts || Object.values(layouts).every((layout) => layout.root)) {
    return session
  }
  return {
    ...session,
    terminalLayoutsByTabId: Object.fromEntries(
      Object.entries(layouts).map(([tabId, layout]) => [tabId, nameEmptyLayoutRoot(layout)])
    )
  }
}

/**
 * Load-only repair. Sessions saved before tabs named their first pane can hold an empty layout
 * root; a later window save of that unmounted tab would drop a binding main made meanwhile.
 * Naming the pane once here means no save ever carries an empty root.
 */
export function nameEmptyPersistedTerminalLayoutRoots(state: PersistedState): PersistedState {
  const workspaceSession = nameEmptyLayoutRootsInSession(state.workspaceSession)
  const hostSessions = state.workspaceSessionsByHostId
  if (!hostSessions) {
    return { ...state, workspaceSession }
  }
  const workspaceSessionsByHostId = Object.fromEntries(
    Object.entries(hostSessions).map(([hostId, session]) => [
      hostId,
      session ? nameEmptyLayoutRootsInSession(session) : session
    ])
  )
  return { ...state, workspaceSession, workspaceSessionsByHostId }
}
