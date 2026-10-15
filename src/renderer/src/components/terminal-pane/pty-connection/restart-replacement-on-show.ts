import { useAppStore } from '@/store'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { FreshSpawnOptions } from './fresh-spawn-types'

// Why by PTY id: a paired client opening the pane names only the dead process, not the pane.
const armedSessionsByPtyId = new Map<string, ConnectPanePtySession>()

/**
 * A terminal service restart ended this pane's process and nothing replaced it. The pane gets its
 * replacement the way a relaunch would (fresh shell, cold-restore agent resume, old output kept),
 * but only once it is shown or opened on a paired client, so a restart never resumes every
 * background agent at once.
 */
export function armRestartReplacement(session: ConnectPanePtySession, ptyId: string): void {
  dropRestartReplacement(session)
  session.restartReplacementPtyId = ptyId
  armedSessionsByPtyId.set(ptyId, session)
  if (session.deps.isVisibleRef.current) {
    // Deferred off the exit handler, as the hibernation wake is.
    queueMicrotask(() => consumeRestartReplacement(session))
  }
}

/** Spawns the armed replacement, unless the pane closed or another flow already rebound it. */
export function consumeRestartReplacement(
  session: ConnectPanePtySession,
  options: FreshSpawnOptions = {}
): void {
  const ptyId: string | null = session.restartReplacementPtyId ?? null
  if (!ptyId) {
    return
  }
  dropRestartReplacement(session)
  const currentPtyId = session.transport.getPtyId()
  const storedPtyId =
    useAppStore.getState().terminalLayoutsByTabId[session.deps.tabId]?.ptyIdsByLeafId?.[
      session.pane.leafId
    ]
  if (
    session.disposed ||
    session.deps.paneTransportsRef.current.get(session.pane.id) !== session.transport ||
    (currentPtyId !== null && currentPtyId !== ptyId) ||
    (storedPtyId !== undefined && storedPtyId !== ptyId)
  ) {
    return
  }
  void session.startFreshColdRestoreAgentResume(undefined, options)
}

/** A paired client (phone or another desktop) opened the pane, which counts as showing it. */
export function consumeRestartReplacementForPty(ptyId: string): boolean {
  const session = armedSessionsByPtyId.get(ptyId)
  if (!session) {
    return false
  }
  consumeRestartReplacement(session, { shownElsewhere: true })
  return true
}

export function dropRestartReplacement(session: ConnectPanePtySession): void {
  const ptyId: string | null = session.restartReplacementPtyId ?? null
  session.restartReplacementPtyId = null
  if (ptyId && armedSessionsByPtyId.get(ptyId) === session) {
    armedSessionsByPtyId.delete(ptyId)
  }
}
