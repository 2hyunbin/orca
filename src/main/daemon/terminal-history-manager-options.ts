import type { HistoryRecoveryFreeze } from './terminal-history-recovery-quarantine'

export type OpenSessionOptions = {
  cwd: string
  cols: number
  rows: number
  recoveryFreeze?: HistoryRecoveryFreeze
  quarantineUnreadableRecovery?: boolean
}

export type HistoryManagerOptions = {
  onWriteError?: (sessionId: string, error: Error) => void
  checkpointMaxBytes?: number
  /** The hosting daemon's resize model (client hello); null or absent means xterm's. */
  resizeModel?: () => string | null
}

export type HistoryCheckpointResult = 'committed' | 'retryable' | 'unavailable'
