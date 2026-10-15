import type { SpawnedProcess } from '@orca/process-host/process-spec'
import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'
import { waitForProcessExitUntil } from './provider-process-exit-deadline'
import type { ProviderCloseRequest, ProviderProcessGroup } from './provider-process-group'
import type { ProviderProcessTeardownVerdict } from './provider-process-teardown'

export type ProviderProcessTree = {
  capture(): Promise<void>
  refresh?: () => Promise<void>
  reap(): Promise<DescendantTreeVerdict>
  readonly treeVerdict: DescendantTreeVerdict
  /** A reap has reached the root while it lived: its exit since then is no longer its own. */
  readonly forcedReapAttempted?: boolean
}

export type ProviderProcessClosePolicy = {
  /** How long a root gets to exit after its close (its group's stop, where it leads one). */
  gracefulExitMs: number
  forcedExitMs: number
  /** Defaults to 'stdin-end': the provider drains, and its group is stopped after the grace. */
  closeRequest?: ProviderCloseRequest
  /** A root that leaves on its own after its stdin ends, with no forced reap ever on its tree, is
   *  the close: no claim is made about its descendants, and no post-exit reap runs. */
  selfExitIsClose?: boolean
}

export type ProviderProcessCloseInput = {
  child: Pick<SpawnedProcess, 'pid' | 'kill' | 'stdin'>
  exitPromise: Promise<void>
  rootVerdict: () => DescendantTreeVerdict
  /** The POSIX group the root leads; its stop is the close's signal ladder. */
  group?: ProviderProcessGroup | null
  policy: ProviderProcessClosePolicy
  tree?: ProviderProcessTree
  terminateTree: () => Promise<ProviderProcessTeardownVerdict>
}

export type ProviderProcessCloseResult = {
  root: DescendantTreeVerdict
  /** Null when this close made no observation of the descendants. */
  tree: DescendantTreeVerdict | null
  /** Set when `selfExitIsClose` decided the close. */
  selfExit?: true
}

export const ROOT_ONLY_GRACEFUL_EXIT_MS = 1_500
const ROOT_ONLY_FORCED_EXIT_MS = 1_000

/** Default for providers without a descendant reaper: end stdin, wait, then the fallback teardown. */
export const rootOnlyProviderClosePolicy: ProviderProcessClosePolicy = {
  gracefulExitMs: ROOT_ONLY_GRACEFUL_EXIT_MS,
  forcedExitMs: ROOT_ONLY_FORCED_EXIT_MS
}

/** A root-only close is done once the root is gone; an unproven tree is reported, not retried. */
export function acceptProviderRootExit(result: ProviderProcessCloseResult): boolean {
  return result.root === 'exited'
}

/** A POSIX group's stop runs the signal ladder; the fallback teardown runs only after it. */
export async function closeProviderProcess(
  input: ProviderProcessCloseInput
): Promise<ProviderProcessCloseResult> {
  const { child, policy, tree } = input
  if (tree) {
    await tree.capture()
  }
  let groupVerdict: DescendantTreeVerdict | null = null
  if (input.group) {
    groupVerdict = (await input.group.stop(policy.closeRequest ?? 'stdin-end'))
      ? 'exited'
      : 'unverifiable'
  } else {
    try {
      child.stdin?.end()
    } catch {
      // A broken pipe still owes the reap.
    }
  }
  let reaped = false
  let fallbackTree: DescendantTreeVerdict | null = groupVerdict
  if (input.rootVerdict() !== 'exited') {
    await waitForProcessExitUntil(input.exitPromise, policy.gracefulExitMs)
    if (input.rootVerdict() !== 'exited') {
      reaped = true
      await tree?.refresh?.()
      if (tree) {
        await tree.reap()
      } else {
        fallbackTree = await input.terminateTree()
      }
      await waitForProcessExitUntil(input.exitPromise, policy.forcedExitMs)
    }
  }
  if (
    policy.selfExitIsClose &&
    !reaped &&
    !tree?.forcedReapAttempted &&
    input.rootVerdict() === 'exited'
  ) {
    return { root: 'exited', tree: completionVerdict(groupVerdict, tree, groupVerdict), selfExit: true }
  }
  if (!reaped && input.rootVerdict() === 'exited' && tree && tree.treeVerdict !== 'exited') {
    await tree.reap()
  }
  return { root: input.rootVerdict(), tree: completionVerdict(groupVerdict, tree, fallbackTree) }
}

function completionVerdict(
  group: DescendantTreeVerdict | null,
  tree: ProviderProcessTree | undefined,
  fallback: DescendantTreeVerdict | null
): DescendantTreeVerdict | null {
  return group === 'unverifiable' ? group : tree ? tree.treeVerdict : fallback
}
