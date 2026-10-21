import type {
  RuntimeWorktreeTerminalCloseResult,
  RuntimeWorktreeTerminalSleepResult
} from '../../../shared/runtime-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { getExplicitWorktreeIdSelector } from '../runtime-worktree-selection'
import { hostSleepKey } from '../terminal/stop/worktree-terminal-sleep-key'
import { resolveWorktreeHostRouting, type LaunchHostRepo } from '../worktree-launch-host-repo'
import type {
  LifecycleCommand,
  LifecycleOutcome,
  WorkspaceLifecycleQueue
} from './workspace-lifecycle-queue'

/** One key per host's copy of a workspace, the same one its terminals sleep under. */
export function workspaceLifecycleKey(hostId: ExecutionHostId, worktreeId: string): string {
  return hostSleepKey(hostId, worktreeId)
}

type LifecycleRuntime = {
  readonly workspaceLifecycle: WorkspaceLifecycleQueue | null
  listRepos: () => readonly LaunchHostRepo[]
  showManagedWorktree: (
    selector: string
  ) => Promise<{ id: string; repoId: string; hostId?: string | null }>
}

/** Runs `command` in its workspace's queue, or directly in a build with none. */
export function runWorkspaceLifecycleCommand<T>(
  queue: WorkspaceLifecycleQueue | null,
  key: string,
  command: LifecycleCommand<T>
): Promise<T> {
  return queue ? queue.submit(key, command) : command.run()
}

/** The queue key of a workspace selector: its host as the repo rows route it, as a delete keys. */
async function terminalWorkspaceKey(runtime: LifecycleRuntime, selector: string): Promise<string> {
  const worktree = await runtime.showManagedWorktree(selector)
  const routing = resolveWorktreeHostRouting(runtime.listRepos(), worktree)
  if (routing.kind === 'ambiguous') {
    throw new Error('worktree_execution_host_unresolved')
  }
  return workspaceLifecycleKey(
    routing.kind === 'resolved' ? routing.hostId : LOCAL_EXECUTION_HOST_ID,
    worktree.id
  )
}

// The host could not say whether the stops took; a terminal observed still live is definite.
export function sleepOutcome(result: RuntimeWorktreeTerminalSleepResult): LifecycleOutcome {
  return result.postStopVerified === false &&
    result.postStopFailure === 'terminal_liveness_unavailable'
    ? 'unverifiable'
    : 'settled'
}

/** A thrown sleep that lost the host's liveness answer; any other error is definite. */
export function sleepLostContact(error: unknown): boolean {
  return error instanceof Error && error.message === 'terminal_liveness_unavailable'
}

export function closeOutcome(result: RuntimeWorktreeTerminalCloseResult): LifecycleOutcome {
  return result.ptyStopVerdict === 'unverifiable' ? 'unverifiable' : 'settled'
}

/** `terminal.sleep`, `terminal.closeAll` and `worktree.sleep` as queued commands. */
export async function queueTerminalWorkspaceCommand<T>(
  runtime: LifecycleRuntime,
  selector: string,
  command: LifecycleCommand<T>
): Promise<T> {
  if (!runtime.workspaceLifecycle) {
    return command.run()
  }
  return runtime.workspaceLifecycle.submit(await terminalWorkspaceKey(runtime, selector), command)
}

/** A delete's key: its host, else the local host; with no id, the selector itself. */
export function deleteLifecycleKey(
  hostId: ExecutionHostId | undefined,
  worktreeId: string | undefined,
  selector: string
): string {
  return worktreeId
    ? workspaceLifecycleKey(hostId ?? LOCAL_EXECUTION_HOST_ID, worktreeId)
    : `selector:${selector}`
}

/** `worktree.sleep`: a phone's or the CLI's sleep of the whole workspace. */
export function queueWorktreeSleep(
  runtime: LifecycleRuntime & {
    sleepManagedWorktree: (selector: string) => Promise<{ worktreeId: string }>
  },
  selector: string
): Promise<{ worktreeId: string }> {
  return queueTerminalWorkspaceCommand(runtime, selector, {
    kind: 'sleep',
    run: () => runtime.sleepManagedWorktree(selector),
    lostContact: sleepLostContact
  })
}

/** `worktree.rm`: keyed by the caller's host and the selector's id, never resolved again. */
export function queueWorkspaceDelete<T>(
  runtime: Pick<LifecycleRuntime, 'workspaceLifecycle'>,
  selector: string,
  hostId: string | undefined,
  run: () => Promise<T>
): Promise<T> {
  const key = deleteLifecycleKey(
    parseExecutionHostId(hostId)?.id,
    getExplicitWorktreeIdSelector(selector) ?? undefined,
    selector
  )
  return runWorkspaceLifecycleCommand(runtime.workspaceLifecycle, key, { kind: 'delete', run })
}
