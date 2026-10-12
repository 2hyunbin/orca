import type { RuntimeTerminalSurfaceRetirements } from './session-tabs/terminal-surface-retirements'
import { OrcaRuntimeWithTouchMobileSessionTabsForWorktree } from './orca-runtime-touch-mobile-session-tabs-for-worktree'

export abstract class OrcaRuntimeWithPersistTerminalSurfaceRetirements extends OrcaRuntimeWithTouchMobileSessionTabsForWorktree {
  /**
   * Retires each surface in the in-memory session partition of the host that owns its worktree.
   * Why: an SSH pane's durable surface lives in that connection's partition; retiring it
   * against the local partition strands the real ghost and bumps a foreign host's epoch.
   * `accepted` held the surface; `unpersisted` had no partition to hold it (or refused the write).
   */
  protected stageTerminalSurfaceRetirements(
    ...args: Parameters<RuntimeTerminalSurfaceRetirements['stageTerminalSurfaceRetirements']>
  ): ReturnType<RuntimeTerminalSurfaceRetirements['stageTerminalSurfaceRetirements']> {
    return this.runtimeTerminalSurfaceRetirements.stageTerminalSurfaceRetirements(...args)
  }

  // Why no rollback: the process is gone, so a failed write leaves the retirement for the next one.
  protected persistStagedTerminalSurfaceRetirements(
    ...args: Parameters<
      RuntimeTerminalSurfaceRetirements['persistStagedTerminalSurfaceRetirements']
    >
  ): ReturnType<RuntimeTerminalSurfaceRetirements['persistStagedTerminalSurfaceRetirements']> {
    return this.runtimeTerminalSurfaceRetirements.persistStagedTerminalSurfaceRetirements(...args)
  }

  // Why synchronous: the exit's stream end cues clients to re-activate, which must find the leaf gone.
  protected retireMobileSessionSurfacesForPty(
    ...args: Parameters<RuntimeTerminalSurfaceRetirements['retireMobileSessionSurfacesForPty']>
  ): ReturnType<RuntimeTerminalSurfaceRetirements['retireMobileSessionSurfacesForPty']> {
    return this.runtimeTerminalSurfaceRetirements.retireMobileSessionSurfacesForPty(...args)
  }

  /** Ships durable retirement proofs on their own frame when no surface removal carries them. */
  protected publishRetiredTerminalSurfaceProofs(
    ...args: Parameters<RuntimeTerminalSurfaceRetirements['publishRetiredTerminalSurfaceProofs']>
  ): ReturnType<RuntimeTerminalSurfaceRetirements['publishRetiredTerminalSurfaceProofs']> {
    return this.runtimeTerminalSurfaceRetirements.publishRetiredTerminalSurfaceProofs(...args)
  }
}
