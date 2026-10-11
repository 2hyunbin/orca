import type { RuntimeTerminalOutputOwner } from './terminal-output-owner'

export function getPtyOutputSequence(output: RuntimeTerminalOutputOwner, ptyId: string): number {
  return output.ptyOutputSequenceById.get(ptyId) ?? 0
}

export function getPtyLifecycleGeneration(
  output: RuntimeTerminalOutputOwner,
  ptyId: string
): number {
  const existing = output.ptyLifecycleGenerationById.get(ptyId)
  if (existing !== undefined) {
    return existing
  }
  const generation = output.nextPtyLifecycleGeneration++
  output.ptyLifecycleGenerationById.set(ptyId, generation)
  return generation
}

export function advancePtyLifecycleGeneration(
  output: RuntimeTerminalOutputOwner,
  ptyId: string
): void {
  output.ptyLifecycleGenerationById.set(ptyId, output.nextPtyLifecycleGeneration++)
  output.host.clearAgentPromptCorrelationForPty(ptyId)
  // A stop intent belongs to one process incarnation; never let it label a
  // replacement process when the provider reports a generation reset.
  output.host.stopRequestedPtyIds.delete(ptyId)
  output.host.agentPromptLifecycleByPtyId.delete(ptyId)
  output.host.agentPromptPermissionSequenceByPtyId.delete(ptyId)
  output.host.agentPromptExplicitStatusFloorByPtyId.set(ptyId, Date.now())
  output.host.legacyWorkerRecovery.deleteRecoveredPty(ptyId)
  // Why: a respawn under the same session id needs its own subscriber-driven attach.
  output.host.resetTerminalViewGeneration(ptyId)
  // Why: a provider response belongs to the process generation that issued
  // it; a respawn must neither reuse its frame nor join its in-flight call.
  output.providerBufferAcquisitionsByPtyId.delete(ptyId)
  output.providerVisibleStateByPtyId.delete(ptyId)
  output.providerVisibleRetryAtByPtyId.delete(ptyId)
}

export function synchronizePtyOutputSequenceFromProvider(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  providerSequence: { value: number; generation: 'continued' | 'reset' },
  runtimeSequenceAtSpawnStart = 0
): number {
  if (
    !Number.isFinite(providerSequence.value) ||
    providerSequence.value < 0 ||
    !Number.isFinite(runtimeSequenceAtSpawnStart) ||
    runtimeSequenceAtSpawnStart < 0
  ) {
    return output.host.getPtyOutputSequence(ptyId)
  }
  const baseline = Math.floor(providerSequence.value)
  const currentSequence = output.host.getPtyOutputSequence(ptyId)
  const sequenceAtSpawnStart = Math.min(currentSequence, Math.floor(runtimeSequenceAtSpawnStart))
  const postSpawnSequence = currentSequence - sequenceAtSpawnStart
  const wasInitialized = output.providerSequenceInitializedPtys.has(ptyId)
  const replacesExistingRuntimeGeneration = wasInitialized || sequenceAtSpawnStart > 0
  const providerOffset =
    providerSequence.generation === 'reset'
      ? sequenceAtSpawnStart
      : (output.providerSequenceOffsetByPtyId.get(ptyId) ?? 0)
  const providerBaseline = providerOffset + baseline

  if (providerSequence.generation === 'reset') {
    output.host.advancePtyLifecycleGeneration(ptyId)
    // Why: daemon respawn/cold restore starts a new absolute domain. Old
    // emulator state cannot remain authoritative over the replacement.
    if (replacesExistingRuntimeGeneration) {
      output.host.disposeHeadlessTerminal(ptyId)
    }
    output.providerModeTrackersByPtyId.delete(ptyId)
    output.host.wslDistroByPtyId.delete(ptyId)
    output.terminalCwdByPtyId.delete(ptyId)
    output.terminalFileUriHostnameByPtyId.delete(ptyId)
    const pty = output.host.ptysById.get(ptyId)
    if (pty) {
      pty.wslDistro = null
    }
    if (replacesExistingRuntimeGeneration && postSpawnSequence === 0) {
      output.host.resetTrackedTerminalStateForProviderGeneration(ptyId)
    }
  }

  const synchronizedSequence =
    providerSequence.generation === 'reset'
      ? currentSequence
      : wasInitialized
        ? currentSequence
        : providerBaseline + postSpawnSequence
  output.ptyOutputSequenceById.set(ptyId, synchronizedSequence)
  output.providerSequenceInitializedPtys.add(ptyId)
  output.providerSequenceOffsetByPtyId.set(ptyId, providerOffset)

  const snapshotMayCoverMissingState =
    (providerSequence.generation === 'continued' && !wasInitialized) ||
    (postSpawnSequence > 0 &&
      providerSequence.generation === 'reset' &&
      replacesExistingRuntimeGeneration) ||
    (providerSequence.generation === 'continued' &&
      wasInitialized &&
      providerBaseline > currentSequence)
  if (snapshotMayCoverMissingState) {
    // Why: bytes can cross the control/stream sockets around attach. Until a
    // full renderer/provider snapshot is available, a partial model is unsafe.
    output.providerSnapshotPreferredPtys.add(ptyId)
  } else if (providerSequence.generation === 'reset') {
    output.providerSnapshotPreferredPtys.delete(ptyId)
  }

  const headless = output.headlessTerminals.get(ptyId)
  if (headless && !wasInitialized && providerSequence.generation === 'continued') {
    // Why: daemon bytes can reach main just before spawn resolves. Queue the
    // baseline behind those writes so their emulator sequence is rebased too.
    headless.writeChain = headless.writeChain.then(() => {
      headless.outputSequence = synchronizedSequence
    })
  }
  return synchronizedSequence
}
