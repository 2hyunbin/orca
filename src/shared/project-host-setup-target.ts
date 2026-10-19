import { parseExecutionHostId, type ExecutionHostId } from './execution-host'

/**
 * Names one setup. Repo-backed setups take the repo id, so twins on different hosts share
 * `setupId` and `hostId` picks the host; older clients omit it and keep the first match by id.
 */
export type ProjectHostSetupTarget = {
  setupId: string
  hostId?: ExecutionHostId
}

type SetupIdentity = { id: string; hostId: string; repoId: string }

export function findProjectHostSetup<T extends SetupIdentity>(
  setups: readonly T[],
  target: ProjectHostSetupTarget
): T | undefined {
  const candidates = setups.filter((setup) => setup.id === target.setupId)
  if (target.hostId === undefined) {
    return candidates[0]
  }
  const exact = candidates.find((setup) => setup.hostId === target.hostId)
  if (exact) {
    return exact
  }
  // Why: an independent setup's id is minted unique, and older servers stored the calling
  // client's own `runtime:` id for themselves, which the RPC schema now reads as `local`.
  const [only] = candidates
  return candidates.length === 1 &&
    !only.repoId &&
    target.hostId === 'local' &&
    parseExecutionHostId(only.hostId)?.kind === 'runtime'
    ? only
    : undefined
}

/** The host that runs a setup: a paired server's setups all carry its `runtime:` id as `hostId`. */
export function getProjectHostSetupExecutionHostId(setup: {
  hostId: ExecutionHostId
  executionHostId?: ExecutionHostId | null
}): ExecutionHostId {
  return setup.executionHostId ?? setup.hostId
}
