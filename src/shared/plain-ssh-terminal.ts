/** The plain SSH terminal's IPC contract: open by saved target id, then talk by session id. */
export const PLAIN_SSH_TERMINAL_CHANNELS = {
  open: 'plainSsh:open',
  write: 'plainSsh:write',
  resize: 'plainSsh:resize',
  close: 'plainSsh:close',
  event: 'plainSsh:event'
} as const

export type PlainSshTerminalOpenResult =
  | { ok: true; sessionId: string; label: string }
  | { ok: false; reason: 'unknown-target' | 'not-blocked' }
  /** This host already has one; the window showing it is brought forward instead. */
  | { ok: false; reason: 'already-open'; sessionId: string }
  | { ok: false; reason: 'ssh-missing' | 'spawn-failed'; message: string }

export type PlainSshTerminalEvent =
  | { kind: 'data'; sessionId: string; data: string }
  | { kind: 'exit'; sessionId: string; exitCode: number }
