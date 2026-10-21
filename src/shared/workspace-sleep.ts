import type { ExecutionHostId } from './execution-host'

/** A host that runs part of a workspace: this desktop's main, or a paired server. */
export type WorkspaceSleepHost = { kind: 'self' } | { kind: 'environment'; environmentId: string }

/** One workspace to sleep, with the hosts its window resolved for its terminals and chats. */
export type WorkspaceSleepTarget = {
  worktreeId: string
  terminalHost: WorkspaceSleepHost
  /** Every host whose chats this workspace may run; none for a directly dialed SSH place. */
  chatHosts: WorkspaceSleepHost[]
}

export type WorkspaceSleepRequest = {
  targets: WorkspaceSleepTarget[]
  /** Only the user's Sleep hides its chats; a project move pauses through the same sleep. */
  markChatsAsleep?: boolean
}

export type WorkspaceChatStopReceipt = {
  executionHostId: ExecutionHostId
  stoppedSessionIds: string[]
}

export type WorkspaceSleepOutcome = {
  worktreeId: string
  /** Why the workspace was kept open: the terminal stop's or the VM suspend's error message. */
  failure?: string
  /** A host could not confirm a chat stopped; stopped terminals stay stopped. */
  chatFailed: boolean
  receipts: WorkspaceChatStopReceipt[]
}

/** What the window follows of a sleep main runs, whoever asked for it. */
export type WorkspaceSleepNotice =
  | { worktreeId: string; phase: 'started' }
  | {
      worktreeId: string
      phase: 'ended'
      /** The terminals main proved stopped, as the window's PTY ids; null when the stop failed. */
      stoppedPtyIds: string[] | null
      slept: boolean
    }
