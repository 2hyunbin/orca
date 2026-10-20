// Tells a paired server which group this window shows in each workspace its frames draw
// (`layout.reportView`), so a CLI or phone file opened on the server lands where the user looks.
// Group ids are the server's own: frames draw its groups under their ids. Fire-and-forget.

import { errorMessage } from '../../../shared/error-message'
import { callRuntimeRpc } from './runtime-rpc-client'
import { changedActiveGroups } from './sync-runtime-graph/active-group-publication'

export type ServerViewReport = {
  /** Sends the frame-drawn workspaces whose group changed since the last send, if any did. */
  update: (
    activeGroupIdByWorktree: Readonly<Record<string, string>>,
    drawn: ReadonlySet<string>
  ) => void
  /** Forgets what was sent: a new stream may come with a connection the server knows nothing of.
   *  The next report of each workspace is a refresh, which never outranks another client's. */
  reset: () => void
}

function only(
  groups: Readonly<Record<string, string>>,
  drawn: ReadonlySet<string>
): Record<string, string> {
  return Object.fromEntries(Object.entries(groups).filter(([key]) => drawn.has(key)))
}

function partition(
  groups: Record<string, string | null>,
  first: (key: string) => boolean
): [Record<string, string | null>, Record<string, string | null>] {
  const entries = Object.entries(groups)
  return [
    Object.fromEntries(entries.filter(([key]) => first(key))),
    Object.fromEntries(entries.filter(([key]) => !first(key)))
  ]
}

function send(
  environmentId: string,
  activeGroupByWorkspace: Record<string, string | null>,
  refresh: boolean
): void {
  if (Object.keys(activeGroupByWorkspace).length === 0) {
    return
  }
  callRuntimeRpc({ kind: 'environment', environmentId }, 'layout.reportView', {
    activeGroupByWorkspace,
    ...(refresh ? { refresh: true } : {})
  }).catch((error: unknown) => {
    // Not resent: the next change or stream reports again, and the server keeps its saved view.
    console.warn('[layout-owner] a server did not take the view report:', errorMessage(error))
  })
}

export function createServerViewReport(environmentId: string): ServerViewReport {
  let sent: Record<string, string> = {}
  /** Workspaces reported since the last reset: a first report re-establishes, a later one is a change. */
  const reported = new Set<string>()
  // Store slices are replaced, never edited: unchanged inputs have nothing new to send.
  let seen: [Readonly<Record<string, string>>, ReadonlySet<string>] | null = null
  return {
    update: (activeGroupIdByWorktree, drawn) => {
      if (seen?.[0] === activeGroupIdByWorktree && seen[1] === drawn) {
        return
      }
      seen = [activeGroupIdByWorktree, drawn]
      const current = only(activeGroupIdByWorktree, drawn)
      // A workspace that left the frames is not reported as showing none: its server keeps the last.
      const changed = changedActiveGroups(current, only(sent, drawn))
      sent = current
      if (!changed) {
        return
      }
      const [refreshed, live] = partition(changed, (key) => !reported.has(key))
      for (const key of Object.keys(changed)) {
        reported.add(key)
      }
      send(environmentId, refreshed, true)
      send(environmentId, live, false)
    },
    reset: () => {
      sent = {}
      seen = null
      reported.clear()
    }
  }
}

/** Calls back each time the shared control connection to `environmentId` comes up on a new socket:
 *  the server dropped the reports of the old one, while the layout stream may have stayed up. */
export function onServerControlConnected(environmentId: string, connected: () => void): () => void {
  let socket: string | null = null
  return (
    window.api?.runtimeEnvironments?.onSharedControlDiagnostics?.((event) => {
      if (event.environmentId !== environmentId || event.diagnostics.state !== 'ready') {
        return
      }
      const next = `${event.transportGeneration}:${event.diagnostics.lastConnectedAt}`
      if (next !== socket) {
        socket = next
        connected()
      }
    }) ?? (() => {})
  )
}
