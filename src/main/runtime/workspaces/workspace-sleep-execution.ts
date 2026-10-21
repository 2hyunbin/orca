import type { AgentSessionWorkspaceSleepResult } from '../../../shared/agent-session-workspace-sleep'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import type { RuntimeWorktreeTerminalSleepResult } from '../../../shared/runtime-types'
import type {
  WorkspaceChatStopReceipt,
  WorkspaceSleepHost,
  WorkspaceSleepNotice,
  WorkspaceSleepOutcome,
  WorkspaceSleepRequest,
  WorkspaceSleepTarget
} from '../../../shared/workspace-sleep'
import {
  requestRemoteWorktreeSleep,
  type RemoteWorkspaceCall
} from './remote-workspace-terminal-sleep'
import type { LifecycleCommand } from './workspace-lifecycle-queue'
import { teardownStops } from '../owned-session-teardown-policy'

export type WorkspaceSleepDeps = {
  /** The window follows: it hides the workspace's browsers and panes before any terminal stops. */
  notify: (notice: WorkspaceSleepNotice) => void
  sleepOwnTerminals: (worktreeId: string) => Promise<RuntimeWorktreeTerminalSleepResult>
  callEnvironment: (environmentId: string) => RemoteWorkspaceCall
  stopOwnChats: (
    worktreeId: string,
    markAsleep: boolean
  ) => Promise<AgentSessionWorkspaceSleepResult>
  /** Whether a paired server keeps Sleep's mark on its chats (older ones refuse the field). */
  environmentMarksSleep: (environmentId: string) => Promise<boolean>
  suspendVm: ((worktreeId: string) => Promise<void>) | null
}

/** The outcome plus whether the host never confirmed it, which pauses the workspace's queue. */
export type WorkspaceSleepAttempt = WorkspaceSleepOutcome & { unverifiable: boolean }

// The host could not say whether the stops took; a terminal observed still live is definite.
const UNCONFIRMED_TERMINAL_FAILURES = new Set(['terminal_liveness_unavailable'])

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function executionHostOf(host: WorkspaceSleepHost): ExecutionHostId {
  return host.kind === 'self'
    ? LOCAL_EXECUTION_HOST_ID
    : toRuntimeExecutionHostId(host.environmentId)
}

/** The terminal PTY ids the window binds, proven stopped; throws when the host cannot prove it. */
async function sleepTerminals(deps: WorkspaceSleepDeps, target: WorkspaceSleepTarget) {
  const host = target.terminalHost
  if (host.kind === 'environment') {
    const handles = await requestRemoteWorktreeSleep(
      deps.callEnvironment(host.environmentId),
      target.worktreeId
    )
    return handles.map((handle) => toRemoteRuntimePtyId(handle, host.environmentId))
  }
  const result = await deps.sleepOwnTerminals(target.worktreeId)
  if (result.postStopVerified !== true) {
    throw Object.assign(new Error(result.postStopFailure), { stoppedPtyIds: result.stoppedPtyIds })
  }
  return result.stoppedPtyIds
}

/** Each host stops only the chats it runs, so every one is asked. Never rejects. */
async function stopChats(
  deps: WorkspaceSleepDeps,
  target: WorkspaceSleepTarget,
  markAsleep: boolean
): Promise<{ receipts: WorkspaceChatStopReceipt[]; failed: boolean }> {
  const settled = await Promise.all(
    target.chatHosts.map(async (host) => {
      try {
        if (host.kind === 'self') {
          return await deps.stopOwnChats(target.worktreeId, markAsleep)
        }
        const mark = markAsleep && (await deps.environmentMarksSleep(host.environmentId))
        const params = mark
          ? { workspaceId: target.worktreeId, markAsleep: true }
          : { workspaceId: target.worktreeId }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the server's agentSession.sleepWorkspace reply; a malformed one reads as failed below.
        return (await deps.callEnvironment(host.environmentId)(
          'agentSession.sleepWorkspace',
          params,
          120_000
        )) as AgentSessionWorkspaceSleepResult
      } catch (error) {
        console.error('[workspace-sleep] native chat stop failed', {
          worktreeId: target.worktreeId,
          error
        })
        return null
      }
    })
  )
  const receipts: WorkspaceChatStopReceipt[] = []
  let failed = false
  for (const [index, result] of settled.entries()) {
    if (!result || !Array.isArray(result.stoppedSessionIds) || result.failures?.length) {
      failed = true
    }
    if (result && Array.isArray(result.stoppedSessionIds)) {
      receipts.push({
        executionHostId: executionHostOf(target.chatHosts[index]),
        stoppedSessionIds: result.stoppedSessionIds
      })
    }
  }
  return { receipts, failed }
}

/**
 * One workspace's sleep, in order: the window hides it, its terminals stop on their host, every
 * host stops its chats, then (once the whole batch's chats settled) its VM suspends.
 */
async function sleepWorkspace(
  deps: WorkspaceSleepDeps,
  target: WorkspaceSleepTarget,
  markAsleep: boolean,
  batch: { chatsSettled: () => void; batchChatsSettled: Promise<unknown> }
): Promise<WorkspaceSleepAttempt> {
  const { worktreeId } = target
  deps.notify({ worktreeId, phase: 'started' })
  let failure: string | undefined
  let unverifiable = false
  let stoppedPtyIds: string[] | null = null
  let chats: Awaited<ReturnType<typeof stopChats>> = { receipts: [], failed: false }
  try {
    try {
      stoppedPtyIds = await sleepTerminals(deps, target)
    } catch (error) {
      failure = messageOf(error)
      // A paired server's refusal carries its code; a call that lost the server carries none.
      const lostServer =
        target.terminalHost.kind === 'environment' && !(error instanceof Error && 'code' in error)
      unverifiable = lostServer || UNCONFIRMED_TERMINAL_FAILURES.has(failure)
      stoppedPtyIds =
        error instanceof Error && 'stoppedPtyIds' in error && Array.isArray(error.stoppedPtyIds)
          ? error.stoppedPtyIds.filter((id): id is string => typeof id === 'string')
          : null
    }
    if (teardownStops('sleep', 'structured-chat')) {
      chats = await stopChats(deps, target, markAsleep)
    }
  } finally {
    batch.chatsSettled()
  }
  // A VM may carry another workspace's host: the whole batch's chats settle before any suspends.
  if (!failure && deps.suspendVm) {
    await batch.batchChatsSettled
    try {
      await deps.suspendVm(worktreeId)
    } catch (error) {
      console.error('[workspace-sleep] host suspension failed', { worktreeId, error })
      failure = messageOf(error)
    }
  }
  deps.notify({ worktreeId, phase: 'ended', slept: !failure, stoppedPtyIds })
  return {
    worktreeId,
    ...(failure ? { failure } : {}),
    chatFailed: chats.failed,
    receipts: chats.receipts,
    // A chat host that never answered is unconfirmed too.
    unverifiable: unverifiable || chats.failed
  }
}

/**
 * Sleeps a batch, each workspace as a command in its own queue (`enqueue`). A workspace whose
 * command a delete cancelled or the queue refused still releases the batch's VM wait.
 */
export async function sleepWorkspaces(
  deps: WorkspaceSleepDeps,
  enqueue: (
    target: WorkspaceSleepTarget,
    command: LifecycleCommand<WorkspaceSleepAttempt>
  ) => Promise<WorkspaceSleepAttempt>,
  request: WorkspaceSleepRequest
): Promise<WorkspaceSleepOutcome[]> {
  // Why unique: both copies of a twin share one id, and sleeping it sleeps the whole workspace.
  const targets = [
    ...new Map(request.targets.map((target) => [target.worktreeId, target])).values()
  ]
  const releases: (() => void)[] = []
  const settled = targets.map(() => new Promise<void>((resolve) => releases.push(resolve)))
  const batchChatsSettled = Promise.all(settled)
  return Promise.all(
    targets.map(async (target, index) => {
      const chatsSettled = releases[index]
      try {
        const { unverifiable: _unverifiable, ...outcome } = await enqueue(target, {
          kind: 'sleep',
          run: () =>
            sleepWorkspace(deps, target, request.markChatsAsleep === true, {
              chatsSettled,
              batchChatsSettled
            }),
          outcome: (attempt) => (attempt.unverifiable ? 'unverifiable' : 'settled')
        })
        return outcome
      } catch (error) {
        chatsSettled()
        return {
          worktreeId: target.worktreeId,
          failure: messageOf(error),
          chatFailed: false,
          receipts: []
        }
      }
    })
  )
}
