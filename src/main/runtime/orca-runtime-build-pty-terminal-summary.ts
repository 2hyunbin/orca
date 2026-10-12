import type { RuntimeTerminalIdentityOwner } from './terminal/identity/terminal-identity-owner'
import { OrcaRuntimeWithGetPtyRecordForPaneKey } from './orca-runtime-get-pty-record-for-pane-key'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { runtimeWorktreeIdentityKey, type ResolvedWorktree } from './runtime-worktree-path-identity'
import type { RuntimeTerminalRead, RuntimeTerminalSummary } from '../../shared/runtime-types'
import { getLatestPtyTitle } from './runtime-worktree-status-projection'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { ptyHoldsRecordedSurface, type PtySurfaceTopology } from './pty-recorded-surface-topology'
import type { TerminalHandleRecord } from './runtime-terminal-contracts'
import { readTerminalTail } from './terminal-tail-read'

export abstract class OrcaRuntimeWithBuildPtyTerminalSummary extends OrcaRuntimeWithGetPtyRecordForPaneKey {
  protected abstract issuePtyHandle(
    ...args: Parameters<RuntimeTerminalIdentityOwner['issuePtyHandle']>
  ): ReturnType<RuntimeTerminalIdentityOwner['issuePtyHandle']>

  protected ptySurfaceTopology(): PtySurfaceTopology {
    return {
      graphSequence: this.graphSequence,
      ptyIdHoldingPane: (tabId, leafId) => this.leaves.get(this.getLeafKey(tabId, leafId))?.ptyId
    }
  }

  protected buildPtyTerminalSummary(
    pty: RuntimePtyWorktreeRecord,
    worktreesById: Map<string, ResolvedWorktree>
  ): RuntimeTerminalSummary {
    const worktree = worktreesById.get(pty.worktreeId)

    const title = getLatestPtyTitle(this.getPtyDisplayRecord(pty))
    const pane = parsePaneKey(pty.paneKey ?? '')
    const orphaned = !ptyHoldsRecordedSurface(pty, this.ptySurfaceTopology())
    // A live process awaiting its pane binding is not evidence of an orphan.
    if (
      orphaned &&
      (this.pendingPtyRegistrationIncarnations.has(pty.ptyId) ||
        this.terminalMutationLock.hasActiveSpawns(runtimeWorktreeIdentityKey(pty.worktreeId)))
    ) {
      throw new Error('terminal_surface_ownership_unavailable')
    }
    return {
      handle: this.issuePtyHandle(pty),
      ptyId: pty.ptyId,
      incarnationId: pty.incarnationId,
      orphaned,
      ...(orphaned && pane && pane.tabId === pty.tabId && pty.paneKey
        ? { recordedPaneKey: pty.paneKey }
        : {}),
      worktreeId: pty.worktreeId,
      worktreePath: worktree?.path ?? '',
      branch: worktree?.branch ?? '',
      tabId: orphaned ? `pty:${pty.ptyId}` : pty.tabId!,
      // SAFETY: Erased narrowing preserves the existing failure when mutable PTY metadata disagrees.
      leafId: orphaned ? `pty:${pty.ptyId}` : pane!.leafId,
      title,
      connected: pty.connected,
      writable: pty.connected,
      lastOutputAt: pty.lastOutputAt,
      preview: pty.preview,
      ...(pty.lastExitCause ? { exitCause: pty.lastExitCause } : {}),
      ...this.terminalExecutionHostField(pty.ptyId, pty.worktreeId),
      ...this.resolvePaneAgentIdentityField(
        pty.launchAgent,
        pty.foregroundAgent,
        title,
        pty.paneKey ?? null
      )
    }
  }

  protected getLiveLeafForHandle(handle: string): {
    record: TerminalHandleRecord
    leaf: RuntimeLeafRecord
  } {
    return this.terminalIdentity.getLiveLeafForHandle(handle)
  }

  protected getLivePtyForHandle(handle: string): {
    record: TerminalHandleRecord
    pty: RuntimePtyWorktreeRecord
  } | null {
    return this.terminalIdentity.getLivePtyForHandle(handle)
  }

  protected assertLiveTerminalHandleTargetsPty(handle: string, expectedPtyId: string): void {
    return this.terminalIdentity.assertLiveTerminalHandleTargetsPty(handle, expectedPtyId)
  }

  protected readPtyTerminal(
    handle: string,
    pty: RuntimePtyWorktreeRecord,
    opts: { cursor?: number; limit?: number } = {}
  ): RuntimeTerminalRead {
    return readTerminalTail({
      handle,
      status: pty.connected ? 'running' : pty.lastExitCode !== null ? 'exited' : 'unknown',
      previewLines: pty.tailBuffer,
      completedLines: pty.tailTranscriptBuffer,
      partialLine: pty.tailPartialLine,
      completedLineCount: pty.tailLinesTotal,
      bufferTruncated: pty.tailTruncated,
      cursor: opts.cursor,
      limit: opts.limit
    })
  }

  protected issueHandle(leaf: RuntimeLeafRecord): string {
    return this.terminalIdentity.issueHandle(leaf)
  }
}
