import type {
  LegacyWorkerRecoveryCandidate,
  LegacyWorkerRecoveryInventory,
  LegacyWorkerRecoveryPorts,
  LegacyWorkerRecoveryResolution,
  LegacyWorkerRecoveryWorkspace
} from './runtime-legacy-worker-terminal-recovery-types'

export async function isAbsentLegacyWorkerTerminalProvenExited(
  ports: LegacyWorkerRecoveryPorts,
  candidate: LegacyWorkerRecoveryCandidate,
  connectionId: string | null
): Promise<boolean> {
  // A restarted relay's session map cannot speak for the previous relay's processes.
  if (connectionId === null) {
    return true
  }
  try {
    return (await ports.isTerminalProvenAbsent?.(candidate)) === true
  } catch {
    return false
  }
}

export async function reconcileLegacyWorkerCandidate(args: {
  ports: LegacyWorkerRecoveryPorts
  candidate: LegacyWorkerRecoveryCandidate
  workspace: LegacyWorkerRecoveryWorkspace
  resolvedWorktrees: LegacyWorkerRecoveryWorkspace['resolved'][]
  inventory: LegacyWorkerRecoveryInventory
  deferredDispatchIds: Set<string>
  pendingResolutions: LegacyWorkerRecoveryResolution[]
}): Promise<void> {
  const { ports, candidate, workspace, resolvedWorktrees } = args
  if (!args.inventory.livePtyIds.has(candidate.ptyId)) {
    if (
      await isAbsentLegacyWorkerTerminalProvenExited(ports, candidate, workspace.scope.connectionId)
    ) {
      args.pendingResolutions.push({ candidate, resolution: 'exited' })
    } else {
      args.deferredDispatchIds.add(candidate.dispatchId)
    }
    return
  }
  const controllerIdentity = args.inventory.terminalIdentityByPtyId.get(candidate.ptyId)
  if (!controllerIdentity) {
    args.deferredDispatchIds.add(candidate.dispatchId)
    return
  }
  if (
    controllerIdentity.handle !== candidate.terminalHandle ||
    controllerIdentity.incarnationId !== candidate.incarnationId
  ) {
    args.pendingResolutions.push({ candidate, resolution: 'exited' })
    return
  }
  let adoptionStatus: 'ready' | 'unverifiable' | 'exited'
  try {
    adoptionStatus = await ports.runMutation(candidate.worktreeId, async () => {
      const preAdoptionInventory = await ports.refreshInventory(
        resolvedWorktrees,
        workspace.scope.connectionId
      )
      if (!preAdoptionInventory) {
        return 'unverifiable'
      }
      if (!preAdoptionInventory.livePtyIds.has(candidate.ptyId)) {
        return (await isAbsentLegacyWorkerTerminalProvenExited(
          ports,
          candidate,
          workspace.scope.connectionId
        ))
          ? 'exited'
          : 'unverifiable'
      }
      const preAdoptionIdentity = preAdoptionInventory.terminalIdentityByPtyId.get(candidate.ptyId)
      if (!preAdoptionIdentity) {
        return 'unverifiable'
      }
      if (
        preAdoptionIdentity.handle !== candidate.terminalHandle ||
        preAdoptionIdentity.incarnationId !== candidate.incarnationId
      ) {
        return 'exited'
      }
      const exactSurfaceAlreadyPublished =
        ports.hasExactPersistedSurface(candidate) && ports.hasExactSurface(candidate)
      if (!exactSurfaceAlreadyPublished) {
        await ports.adopt(
          candidate,
          workspace.scope,
          preAdoptionInventory,
          ports.getActivation(candidate.worktreeId)
        )
      }
      return 'ready'
    })
  } catch (error) {
    console.warn('[orchestration] legacy worker terminal adoption deferred', {
      dispatchId: candidate.dispatchId,
      error
    })
    args.deferredDispatchIds.add(candidate.dispatchId)
    return
  }
  if (adoptionStatus === 'unverifiable') {
    args.deferredDispatchIds.add(candidate.dispatchId)
    return
  }
  if (adoptionStatus === 'exited') {
    args.pendingResolutions.push({ candidate, resolution: 'exited' })
    return
  }
  const finalInventory = await ports.refreshInventory(
    resolvedWorktrees,
    workspace.scope.connectionId
  )
  if (!finalInventory) {
    args.deferredDispatchIds.add(candidate.dispatchId)
    return
  }
  if (!finalInventory.livePtyIds.has(candidate.ptyId)) {
    if (
      await isAbsentLegacyWorkerTerminalProvenExited(ports, candidate, workspace.scope.connectionId)
    ) {
      ports.onPtyExit(candidate)
      args.pendingResolutions.push({ candidate, resolution: 'exited' })
    } else {
      args.deferredDispatchIds.add(candidate.dispatchId)
    }
    return
  }
  const finalIdentity = finalInventory.terminalIdentityByPtyId.get(candidate.ptyId)
  if (!finalIdentity) {
    args.deferredDispatchIds.add(candidate.dispatchId)
    return
  }
  if (
    finalIdentity.handle !== candidate.terminalHandle ||
    finalIdentity.incarnationId !== candidate.incarnationId
  ) {
    args.pendingResolutions.push({ candidate, resolution: 'exited' })
    return
  }
  args.pendingResolutions.push({ candidate, resolution: 'adopted' })
}
