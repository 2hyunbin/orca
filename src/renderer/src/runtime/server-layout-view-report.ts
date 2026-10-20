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
  /** Forgets what was sent: a new stream may come with a connection the server knows nothing of. */
  reset: () => void
}

function only(
  groups: Readonly<Record<string, string>>,
  drawn: ReadonlySet<string>
): Record<string, string> {
  return Object.fromEntries(Object.entries(groups).filter(([key]) => drawn.has(key)))
}

export function createServerViewReport(environmentId: string): ServerViewReport {
  let sent: Record<string, string> = {}
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
      callRuntimeRpc({ kind: 'environment', environmentId }, 'layout.reportView', {
        activeGroupByWorkspace: changed
      }).catch((error: unknown) => {
        // Not resent: the next change or stream reports again, and the server keeps its saved view.
        console.warn('[layout-owner] a server did not take the view report:', errorMessage(error))
      })
    },
    reset: () => {
      sent = {}
      seen = null
    }
  }
}
