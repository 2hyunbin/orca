// A fake runtime store made to answer as a profile Store does for main's layout: sessions
// partitioned by execution host, the host list, and `layout.apply` on the routed partition.
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { LayoutCommand } from '../../shared/workspace-layout/workspace-layout-command-types'
import { resolveHostId } from '../persistence/loading-store/session-host-partitions'
import { applyCommandToSession } from '../persistence/terminal-topology/terminal-pane-admission'

type SessionStore = {
  getWorkspaceSession?: (hostId?: string) => WorkspaceSessionState | null | undefined
  setWorkspaceSession?: (session: WorkspaceSessionState, hostId?: string) => void
  getWorkspaceSessionHostIds?: () => readonly string[]
  applyLayoutCommand?: (command: LayoutCommand, hostIds?: readonly string[]) => Promise<unknown>
}

// The partitions a store without its own host list has had panes bound in.
const boundHostIdsByStore = new WeakMap<SessionStore, Set<string>>()

const installedSessionStores = new WeakSet<SessionStore>()
const installedLayoutApplies = new WeakSet<SessionStore>()

/** Drops the in-memory session bindPaneFirst gave a store shared across tests, so none leaks. */
export function forgetInstalledPaneSession(shared: object): void {
  const store: SessionStore = shared
  if (installedLayoutApplies.delete(store)) {
    delete store.applyLayoutCommand
  }
  if (!installedSessionStores.delete(store)) {
    return
  }
  delete store.getWorkspaceSession
  delete store.setWorkspaceSession
  if (boundHostIdsByStore.delete(store)) {
    delete store.getWorkspaceSessionHostIds
  }
}

export function storeOf(runtime: object): SessionStore | null {
  const store: unknown = Reflect.get(runtime, 'store')
  return store && typeof store === 'object' ? store : null
}

/**
 * Gives the store what it lacks of a profile's session API, remembering it for
 * forgetInstalledPaneSession, and records `hostId` among its partitions.
 */
export function asProfileSessionStore(
  store: SessionStore,
  hostId: string
): {
  get: (host: string) => WorkspaceSessionState
  set: (session: WorkspaceSessionState, host: string) => void
} {
  if (!store.getWorkspaceSession || !store.setWorkspaceSession) {
    installedSessionStores.add(store)
    // Partitioned by execution host, as the profile Store keeps sessions.
    const sessions = new Map<string, WorkspaceSessionState>()
    store.getWorkspaceSession = (host = 'local') =>
      sessions.get(host) ?? getDefaultWorkspaceSession()
    store.setWorkspaceSession = (next, host = 'local') => {
      sessions.set(host, next)
    }
  }
  if (!store.getWorkspaceSessionHostIds) {
    const hostIds = new Set<string>()
    boundHostIdsByStore.set(store, hostIds)
    store.getWorkspaceSessionHostIds = () => [...hostIds]
  }
  const { getWorkspaceSession, setWorkspaceSession } = store
  if (!store.applyLayoutCommand) {
    installedLayoutApplies.add(store)
    store.applyLayoutCommand = async (command, hostIds = []) => {
      const host = resolveHostId(hostIds[0])
      const change = applyCommandToSession(
        host,
        getWorkspaceSession(host) ?? getDefaultWorkspaceSession(),
        command
      )
      if (change.session) {
        setWorkspaceSession(change.session, host)
      }
      return change.value
    }
  }
  boundHostIdsByStore.get(store)?.add(hostId)
  return {
    get: (host) => getWorkspaceSession(host) ?? getDefaultWorkspaceSession(),
    set: (session, host) => setWorkspaceSession(session, host)
  }
}

/** The session main's layout reads from the runtime's store, as bindPaneFirst left it. */
export function boundSessionOf(runtime: object, hostId = 'local'): WorkspaceSessionState {
  return storeOf(runtime)?.getWorkspaceSession?.(hostId) ?? getDefaultWorkspaceSession()
}
