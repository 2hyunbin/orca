import { agentHookServer } from '../../../agent-hooks/server'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'

type ExportedPaneKeyPty = Pick<RuntimePtyWorktreeRecord, 'ptyId' | 'connected' | 'envPaneKey'>

/**
 * A live terminal shown in a pane other than the one its env exported (a restart re-homed it into
 * a new tab) keeps posting hooks under the exported key, so that key's agent status follows it.
 * Run over every record at once: a key another live terminal also exported or shows is ambiguous.
 */
export function followExportedPaneKeys<T extends ExportedPaneKeyPty>(
  records: Iterable<T>,
  paneKeyOf: (pty: T) => string | null
): void {
  const live = Array.from(records).flatMap((pty) =>
    pty.connected ? [{ ptyId: pty.ptyId, envPaneKey: pty.envPaneKey, paneKey: paneKeyOf(pty) }] : []
  )
  const moved = live.flatMap(({ ptyId, envPaneKey, paneKey }) =>
    envPaneKey && paneKey && envPaneKey !== paneKey ? [{ ptyId, envPaneKey, paneKey }] : []
  )
  if (moved.length === 0) {
    return
  }
  const claimants = new Map<string, number>()
  for (const pty of live) {
    for (const paneKey of new Set([pty.envPaneKey, pty.paneKey])) {
      if (paneKey) {
        claimants.set(paneKey, (claimants.get(paneKey) ?? 0) + 1)
      }
    }
  }
  for (const { ptyId, envPaneKey, paneKey } of moved) {
    if (claimants.get(envPaneKey) === 1) {
      agentHookServer.transferPaneAuthority(envPaneKey, paneKey, ptyId, Date.now(), {
        authorityVerified: true
      })
    } else {
      agentHookServer.forgetPaneKeyAlias(envPaneKey, ptyId)
    }
  }
}
