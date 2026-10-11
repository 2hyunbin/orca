import type { RuntimeMobileSessionTabsResult } from './runtime-session-contracts'

/**
 * The last layout one paired server sent this desktop (design 6.3, D3), kept so a restart while
 * the server is offline can still draw its tabs. Display-only: never edited, never sent back.
 */
export type RemoteLayoutSnapshot = {
  receivedAt: number
  serverRuntimeId: string
  /** The stream the frames came from, so a later stream can be stored without a migration. */
  protocol: 'session-tabs'
  /** Keyed by worktree id, each the server's last `session.tabs` result for it. */
  workspaces: Record<string, RuntimeMobileSessionTabsResult>
}
