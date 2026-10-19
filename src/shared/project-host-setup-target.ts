import type { ExecutionHostId } from './execution-host'

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
  // Why: independent setup ids are minted unique, so a host mismatch there is a spelling
  // difference (a client-minted `runtime:` stamp), never a sibling host's setup.
  const [only] = candidates
  return candidates.length === 1 && !only.repoId ? only : undefined
}

/** The host that runs a setup: a paired server's setups all carry its `runtime:` id as `hostId`. */
export function getProjectHostSetupExecutionHostId(setup: {
  hostId: ExecutionHostId
  executionHostId?: ExecutionHostId | null
}): ExecutionHostId {
  return setup.executionHostId ?? setup.hostId
}
