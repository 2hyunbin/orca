import type { RetiredTerminalSurface } from '../mobile-session-terminal-retirement'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionRetiredTerminalSurface
} from '../../../shared/runtime-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { retireTerminalSurfaceFromPersistence } from '../mobile-session-terminal-persistence-retirement'
import { retireTerminalSurfacesFromSnapshot } from '../mobile-session-terminal-retirement'
import { attachRetirementProofsToSnapshot } from '../mobile-session-terminal-retirement-proof'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import type { RuntimeStore } from '../runtime-store-contract'

export type RuntimeTerminalSurfaceRetirementsHost = {
  getStore(): Pick<
    RuntimeStore,
    'getWorkspaceSession' | 'setWorkspaceSession' | 'runDurableMutation'
  > | null
  tryGetWorkspaceSessionHostIdForWorktree(worktreeId: string): ExecutionHostId | null
  getPtyHandle(ptyId: string): string | undefined
  findHandleForPtyRecord(ptyId: string): string | null
  getMobileSnapshots(): Map<string, RuntimeMobileSessionTabsSnapshot>
  getTopologyRevisions(): Map<string, number>
  storeMobileSessionSnapshot(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsSnapshot
  notifyMobileSessionTabsChanged(worktreeId: string): void
  stageTerminalSurfaceRetirements: RuntimeTerminalSurfaceRetirements['stageTerminalSurfaceRetirements']
  publishRetiredTerminalSurfaceProofs: RuntimeTerminalSurfaceRetirements['publishRetiredTerminalSurfaceProofs']
  persistStagedTerminalSurfaceRetirements: RuntimeTerminalSurfaceRetirements['persistStagedTerminalSurfaceRetirements']
}

export class RuntimeTerminalSurfaceRetirements {
  constructor(private readonly host: RuntimeTerminalSurfaceRetirementsHost) {}

  private get store(): ReturnType<RuntimeTerminalSurfaceRetirementsHost['getStore']> {
    return this.host.getStore()
  }

  stageTerminalSurfaceRetirements(retiredSurfaces: readonly RetiredTerminalSurface[]): {
    accepted: RetiredTerminalSurface[]
    unpersisted: RetiredTerminalSurface[]
  } {
    const accepted: RetiredTerminalSurface[] = []
    const unpersisted: RetiredTerminalSurface[] = []
    for (const surface of retiredSurfaces) {
      const hostId =
        this.host.tryGetWorkspaceSessionHostIdForWorktree(surface.worktreeId) ??
        LOCAL_EXECUTION_HOST_ID
      const current = this.store?.getWorkspaceSession?.(hostId)
      if (!current) {
        unpersisted.push(surface)
        continue
      }
      const next = retireTerminalSurfaceFromPersistence(current, surface)
      if (next === current) {
        continue
      }
      try {
        this.store!.setWorkspaceSession!(next, hostId)
        accepted.push(surface)
      } catch (error) {
        // Why: the process is gone whether or not the profile admits the write (quit, maintenance).
        console.error('[runtime] could not stage terminal retirement:', error)
        unpersisted.push(surface)
      }
    }
    return { accepted, unpersisted }
  }

  async persistStagedTerminalSurfaceRetirements(): Promise<void> {
    if (!this.store?.runDurableMutation) {
      return
    }
    try {
      // Why if-dirty: an earlier write, or another exit's, may already carry this retirement.
      await this.store.runDurableMutation(() => ({ value: undefined, persist: 'if-dirty' }))
    } catch (error) {
      console.error('[runtime] terminal retirement is not yet durable:', error)
    }
  }

  retireMobileSessionSurfacesForPty(
    ptyId: string,
    incarnationId: string,
    exactSurfaces: readonly Pick<RetiredTerminalSurface, 'worktreeId' | 'parentTabId' | 'leafId'>[]
  ): Promise<void> | undefined {
    const terminalHandle =
      this.host.getPtyHandle(ptyId) ?? this.host.findHandleForPtyRecord(ptyId) ?? undefined
    const retiredSurfaceByKey = new Map<string, RetiredTerminalSurface>()
    for (const surface of exactSurfaces) {
      retiredSurfaceByKey.set(`${surface.worktreeId}\0${surface.parentTabId}\0${surface.leafId}`, {
        ...surface,
        ptyId,
        incarnationId
      })
    }
    for (const [worktreeId, snapshot] of this.host.getMobileSnapshots()) {
      const retired = retireTerminalSurfacesFromSnapshot({
        snapshot,
        ptyId,
        exactSurfaces: exactSurfaces.filter((surface) => surface.worktreeId === worktreeId),
        exactOnly: exactSurfaces.length > 0
      })
      if (!retired) {
        continue
      }
      for (const surface of retired.retired) {
        retiredSurfaceByKey.set(
          `${surface.worktreeId}\0${surface.parentTabId}\0${surface.leafId}`,
          { ...surface, incarnationId }
        )
      }
    }
    const retiredSurfaces = [...retiredSurfaceByKey.values()]
    if (retiredSurfaces.length === 0) {
      return undefined
    }
    const staged = this.host.stageTerminalSurfaceRetirements(retiredSurfaces)
    for (const surface of staged.unpersisted) {
      const repoId = getRepoIdFromWorktreeId(surface.worktreeId)
      this.host
        .getTopologyRevisions()
        .set(repoId, (this.host.getTopologyRevisions().get(repoId) ?? 0) + 1)
    }
    // Why: one repo epoch can cover multiple exits; a surface the session binds to another PTY or incarnation stays.
    const removableRetiredSurfaces = [...staged.accepted, ...staged.unpersisted]
    for (const [worktreeId, snapshot] of this.host.getMobileSnapshots()) {
      // Why proofs aren't gated on `removable`: the exit is the attestation, and a surface the
      // renderer already de-persisted leaves persistence nothing to accept. Withholding the proof
      // then strands the mirror's pane until a second inventory a quiet workspace never sends.
      const retirementProofs = terminalHandle
        ? retiredSurfaces
            .filter((surface) => surface.worktreeId === worktreeId)
            .map((surface) => ({
              parentTabId: surface.parentTabId,
              leafId: surface.leafId,
              ptyId: surface.ptyId,
              terminal: terminalHandle,
              incarnationId
            }))
        : []
      const removableSurfaces = removableRetiredSurfaces.filter(
        (surface) => surface.worktreeId === worktreeId
      )
      const retired =
        removableSurfaces.length > 0
          ? retireTerminalSurfacesFromSnapshot({
              snapshot,
              ptyId,
              exactSurfaces: removableSurfaces,
              // Why: discovery is broad by PTY id, but publication may remove only surfaces the session retired.
              exactOnly: true,
              ...(retirementProofs.length > 0 ? { retirementProofs } : {})
            })
          : null
      if (retired) {
        this.host.storeMobileSessionSnapshot(worktreeId, retired.snapshot)
        this.host.notifyMobileSessionTabsChanged(worktreeId)
        continue
      }
      this.host.publishRetiredTerminalSurfaceProofs(worktreeId, retirementProofs)
    }
    return staged.accepted.length > 0
      ? this.host.persistStagedTerminalSurfaceRetirements()
      : undefined
  }

  publishRetiredTerminalSurfaceProofs(
    worktreeId: string,
    proofs: readonly RuntimeMobileSessionRetiredTerminalSurface[]
  ): void {
    const snapshot = this.host.getMobileSnapshots().get(worktreeId)
    if (!snapshot) {
      return
    }
    const next = attachRetirementProofsToSnapshot(snapshot, proofs)
    if (!next) {
      return
    }
    this.host.storeMobileSessionSnapshot(worktreeId, next)
    this.host.notifyMobileSessionTabsChanged(worktreeId)
  }
}
