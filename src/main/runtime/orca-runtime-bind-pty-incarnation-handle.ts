import { OrcaRuntimeWithBuildPtyTerminalSummary } from './orca-runtime-build-pty-terminal-summary'
import type { PtyIncarnationHandleRecord } from './orca-runtime-core'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

export abstract class OrcaRuntimeWithBindPtyIncarnationHandle extends OrcaRuntimeWithBuildPtyTerminalSummary {
  protected bindPtyIncarnationHandle(
    retained: PtyIncarnationHandleRecord,
    leaf: RuntimeLeafRecord
  ): void {
    return this.terminalIdentity.bindPtyIncarnationHandle(retained, leaf)
  }

  protected invalidatePtyIncarnationHandle(ptyId: string): void {
    return this.terminalIdentity.invalidatePtyIncarnationHandle(ptyId)
  }

  protected clearPtyIncarnationHandles(): void {
    return this.terminalIdentity.clearPtyIncarnationHandles()
  }

  protected reconcilePtyIncarnationHandles(): void {
    return this.terminalIdentity.reconcilePtyIncarnationHandles()
  }

  protected adoptPreAllocatedHandle(leaf: RuntimeLeafRecord): string | null {
    return this.terminalIdentity.adoptPreAllocatedHandle(leaf)
  }

  protected issuePtyHandle(pty: RuntimePtyWorktreeRecord): string {
    return this.terminalIdentity.issuePtyHandle(pty)
  }

  protected findHandleForPtyRecord(ptyId: string): string | null {
    return this.terminalIdentity.findHandleForPtyRecord(ptyId)
  }

  protected refreshWritableFlags(): void {
    for (const leaf of this.leaves.values()) {
      leaf.writable = this.graphStatus === 'ready' && leaf.connected && leaf.ptyId !== null
    }
  }

  protected invalidateLeafHandle(leafKey: string): void {
    return this.terminalIdentity.invalidateLeafHandle(leafKey)
  }

  protected adoptFirstPtyForLeafHandle(
    leafKey: string,
    ptyId: string | null,
    ptyGeneration: number
  ): boolean {
    return this.terminalIdentity.adoptFirstPtyForLeafHandle(leafKey, ptyId, ptyGeneration)
  }

  protected rememberDetachedPreAllocatedLeaves(): void {
    return this.terminalIdentity.rememberDetachedPreAllocatedLeaves()
  }
}
