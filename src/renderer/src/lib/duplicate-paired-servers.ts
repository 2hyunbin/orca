/**
 * Saved servers that are one machine paired twice. Each publishes the same workspaces, so a write to
 * any of them is ambiguous until the user removes one entry.
 */
import { parseExecutionHostId } from '../../../shared/execution-host'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { translate } from '@/i18n/i18n'
import { WORKTREE_REMOVAL_AMBIGUOUS_ERROR } from '@/store/slices/worktrees/listing/worktree-slice-constants'

type DuplicateServerEnvironment = Pick<
  PublicKnownRuntimeEnvironment,
  'id' | 'name' | 'hostKeyFingerprint'
>

type WorkspaceOwnerRow = { id: string; hostId?: string; runtimeOwnerEnvironmentId?: string }

export type DuplicateServerState = {
  runtimeEnvironments?: readonly DuplicateServerEnvironment[]
  worktreesByRepo?: Record<string, readonly WorkspaceOwnerRow[]>
  detectedWorktreesByRepo?: Record<string, { worktrees: readonly WorkspaceOwnerRow[] }>
  folderWorkspaces?: readonly { id: string; executionHostId?: string | null }[]
}

/** Other saved servers carrying this one's host key, by name. */
export function duplicatePairedServerNames(
  environments: readonly DuplicateServerEnvironment[],
  environmentId: string
): string[] {
  const self = environments.find((environment) => environment.id === environmentId)
  const key = self?.hostKeyFingerprint
  return key
    ? environments
        .filter(
          (environment) =>
            environment.id !== environmentId && environment.hostKeyFingerprint === key
        )
        .map((environment) => environment.name)
    : []
}

function runtimeEnvironmentIdOf(row: {
  hostId?: string | null
  runtimeOwnerEnvironmentId?: string
}) {
  const host = parseExecutionHostId(row.hostId ?? undefined)
  return (
    row.runtimeOwnerEnvironmentId ?? (host?.kind === 'runtime' ? host.environmentId : undefined)
  )
}

/** Saved servers whose rows publish this workspace. */
function publishingEnvironmentIds(state: DuplicateServerState, workspaceId: string): Set<string> {
  const ids = new Set<string>()
  const add = (row: { hostId?: string | null; runtimeOwnerEnvironmentId?: string }) => {
    const id = runtimeEnvironmentIdOf(row)
    if (id) {
      ids.add(id)
    }
  }
  for (const rows of Object.values(state.worktreesByRepo ?? {})) {
    rows.filter((row) => row.id === workspaceId).forEach(add)
  }
  for (const { worktrees } of Object.values(state.detectedWorktreesByRepo ?? {})) {
    worktrees.filter((row) => row.id === workspaceId).forEach(add)
  }
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    for (const folder of state.folderWorkspaces ?? []) {
      if (folder.id === scope.folderWorkspaceId) {
        add({ hostId: folder.executionHostId })
      }
    }
  }
  return ids
}

/** Two saved servers with one host key that both publish this workspace, or null. */
export function findDuplicatePairedServersForWorkspace(
  state: DuplicateServerState,
  workspaceId: string
): [string, string] | null {
  const publishing = publishingEnvironmentIds(state, workspaceId)
  const environments = (state.runtimeEnvironments ?? []).filter((environment) =>
    publishing.has(environment.id)
  )
  for (const environment of environments) {
    const twin = environments.find(
      (other) =>
        other.id !== environment.id &&
        environment.hostKeyFingerprint !== undefined &&
        other.hostKeyFingerprint === environment.hostKeyFingerprint
    )
    if (twin) {
      return [environment.name, twin.name]
    }
  }
  return null
}

/**
 * Why a specific message: refreshing never resolves a server paired twice, so the generic advice
 * leaves the user stuck. Every other ambiguity keeps the generic text.
 */
export function ambiguousWorkspaceOwnerMessage(
  state: DuplicateServerState,
  workspaceId: string
): string {
  const duplicate = findDuplicatePairedServersForWorkspace(state, workspaceId)
  return duplicate
    ? translate(
        'auto.lib.duplicatePairedServers.ambiguousSameServer',
        '{{value0}} and {{value1}} are the same server paired twice. Remove one in Settings > Remote Orca Servers.',
        { value0: duplicate[0], value1: duplicate[1] }
      )
    : WORKTREE_REMOVAL_AMBIGUOUS_ERROR
}
