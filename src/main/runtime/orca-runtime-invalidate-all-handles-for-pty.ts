// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithResolveKnownWorkspaceFileTarget } from './orca-runtime-resolve-known-workspace-file-target'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import { getPtyExecutionHost } from '../../shared/terminal-execution-host'
import { getConnectionExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'

export class OrcaRuntimeWithInvalidateAllHandlesForPty extends OrcaRuntimeWithResolveKnownWorkspaceFileTarget {
  protected invalidateAllHandlesForPty(ptyId: string, preserveHandle?: string): Set<string> {
    return this.terminalIdentity.invalidateAllHandlesForPty(ptyId, preserveHandle)
  }

  protected replaceSyntheticTerminalHandlesForRestoredPty(
    ptyId: string,
    controllerHandle: string
  ): boolean {
    return this.terminalIdentity.replaceSyntheticTerminalHandlesForRestoredPty(
      ptyId,
      controllerHandle
    )
  }

  // Why: adoption is best-effort restart recovery and must be first-wins.
  // Re-keying a pty that already has a handle this session would strand
  // waiters registered under the old handle, and provider-reported values
  // are not trusted to be collision-free — a handle bound to a different
  // pty must never be stolen by a later report.
  protected isTerminalHandleAdoptionBlocked(ptyId: string, handle: string): boolean {
    return this.terminalIdentity.isTerminalHandleAdoptionBlocked(ptyId, handle)
  }

  protected invalidatePtyControllerInventoryForLifecycle(
    ptyId: string,
    connectionId?: string | null
  ): void {
    const generation = ++this.ptyControllerInventorySequence
    const hostId = getPtyExecutionHost(ptyId)
    if (hostId === 'foreign' || (hostId && parseExecutionHostId(hostId)?.kind === 'runtime')) {
      this.ptyControllerAggregateInventoryGeneration = generation
      return
    }
    const connection =
      connectionId === undefined ? this.ptysById.get(ptyId)?.connectionId : connectionId
    const providerKey = hostId ?? getConnectionExecutionHostId(connection)
    // A pending census predates this admission or exit, including legacy IDs without an incarnation.
    this.ptyControllerInventoryGenerationByProvider.set(providerKey, generation)
  }

  onPtySpawned(
    ptyId: string,
    incarnationId?: PtyIncarnationId,
    options: { awaitsRegistration?: boolean } = {}
  ): void {
    this.invalidatePtyControllerInventoryForLifecycle(ptyId)
    const existingPty = this.ptysById.get(ptyId)
    if (
      existingPty &&
      incarnationId !== undefined &&
      existingPty.incarnationId !== null &&
      existingPty.incarnationId !== incarnationId
    ) {
      // Providers announce a child before the commit binds its pane. Fence the
      // predecessor now so a reused id cannot route through its old handle in
      // that gap.
      this.rememberPtyHandleReplacementFence(
        ptyId,
        incarnationId,
        this.invalidateAllHandlesForPty(ptyId),
        true
      )
    }
    this.ptyLivenessVerdictByPtyId.delete(ptyId)
    this.stopRequestedPtyIds.delete(ptyId)
    if (options.awaitsRegistration !== false) {
      // Why: surface absence cannot distinguish an in-flight admission from a completed headless lifecycle.
      this.pendingPtyRegistrationIncarnations.set(ptyId, incarnationId ?? null)
    }
    this.terminalLayout.commands.markTerminalSpawnPublished(ptyId)
    const pty = this.getOrCreatePtyWorktreeRecord(ptyId)
    if (pty) {
      if (incarnationId) {
        pty.incarnationId = incarnationId
      }
      pty.connected = true
      pty.disconnectedAt = null
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      leaf.connected = true
      leaf.writable = this.graphStatus === 'ready'
      this.adoptPreAllocatedHandle(leaf)
    }
  }
}
