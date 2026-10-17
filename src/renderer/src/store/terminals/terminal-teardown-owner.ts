import {
  isRemoteRuntimePtyId,
  parseRemoteRuntimePtyId
} from '../../../../shared/remote-runtime-pty-id'
import type { WorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'

export type TerminalTeardownOwners =
  | { kind: 'resolved'; runtimeEnvironmentIds: string[] }
  | { kind: 'refused'; reason: 'ambiguous_terminal_owner' }

/**
 * Which runtime hosts must stop these PTYs. When two hosts publish the worktree, each
 * `remote:<env>@@…` id names its own owner; a PTY that names none (or no PTY at all) can't be
 * attributed, so teardown is refused rather than treated as local.
 */
export function resolveTerminalTeardownOwners(
  worktreeOwner: WorktreeRuntimeOwner,
  ptyIds: readonly string[]
): TerminalTeardownOwners {
  if (worktreeOwner.kind === 'runtime') {
    return { kind: 'resolved', runtimeEnvironmentIds: [worktreeOwner.environmentId] }
  }
  if (worktreeOwner.kind === 'non-runtime') {
    return { kind: 'resolved', runtimeEnvironmentIds: [] }
  }
  // Why: with no bound PTY there is nothing to attribute, and the server may still run the agent.
  if (ptyIds.length === 0) {
    return { kind: 'refused', reason: 'ambiguous_terminal_owner' }
  }
  const environmentIds = new Set<string>()
  for (const ptyId of ptyIds) {
    if (!isRemoteRuntimePtyId(ptyId)) {
      continue
    }
    const environmentId = parseRemoteRuntimePtyId(ptyId)?.environmentId?.trim()
    if (!environmentId) {
      return { kind: 'refused', reason: 'ambiguous_terminal_owner' }
    }
    environmentIds.add(environmentId)
  }
  return { kind: 'resolved', runtimeEnvironmentIds: [...environmentIds].sort() }
}
