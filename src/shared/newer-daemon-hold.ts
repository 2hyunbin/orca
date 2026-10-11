/** Spawn refusal marker: the requested session may still run in a newer Orca build's daemon. */
export const NEWER_DAEMON_HOLD_ERROR = 'terminal_held_by_newer_daemon'

/** A restored terminal held back because a newer Orca build's daemon may still be running it. */
export type NewerDaemonHold =
  | { held: false }
  | {
      held: true
      /** Last saved screen, shown read-only; null when no history was saved. */
      restoredScreen: { scrollback: string; cols: number; rows: number } | null
    }

export type NewerDaemonReopenResult = { reopened: boolean }

/** Main → every renderer window: the newer daemons are confirmed stopped. */
export const NEWER_DAEMON_RELEASED_CHANNEL = 'pty:newerDaemonReleased'
