import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../runtime-terminal-state-records'
import {
  buildPtyTerminalWaitBlockedResult,
  buildPtyTerminalWaitResult,
  buildTerminalWaitBlockedResult,
  buildTerminalWaitResult
} from '../../terminal-wait-results'
import type { AgentStatus } from '../../../../shared/agent-detection'
import { detectExplicitIdleStatusFromTitle } from '../../terminal-wait-detection'
import { buildTerminalWaitText } from '../../terminal-wait-tail-state'
import { evaluateTuiIdle, type TuiIdleVerdict } from '../../tui-idle-evidence'
import {
  leafTuiIdleEvidence,
  ptyTuiIdleEvidence,
  type TuiIdleEvidenceSource
} from '../../tui-idle-evidence-source'
import type { RuntimeTerminalWaiterRegistry } from './terminal-waiter-registry'

type TerminalWaitSettlementHost = {
  issueHandle(leaf: RuntimeLeafRecord): string | null
  getLeafKey(tabId: string, leafId: string): string
  getLeafHandle(leafKey: string): string | undefined
  getPtyHandle(ptyId: string): string | undefined
  getPtyIncarnationHandle(ptyId: string): string | undefined
  getLeaves(): Iterable<RuntimeLeafRecord>
  getTabTitle(tabId: string): string | undefined
}

export class TerminalWaitSettlements {
  constructor(
    private readonly host: TerminalWaitSettlementHost,
    private readonly terminalWaiters: RuntimeTerminalWaiterRegistry,
    private readonly tuiIdleEvidenceSource: TuiIdleEvidenceSource
  ) {}

  resolveExitWaiters(leaf: RuntimeLeafRecord): void {
    const handle = this.host.issueHandle(leaf)
    if (!handle) {
      return
    }
    const waiters = this.terminalWaiters.get(handle)
    if (!waiters || waiters.size === 0) {
      return
    }
    for (const waiter of Array.from(waiters)) {
      if (waiter.condition === 'exit') {
        this.terminalWaiters.resolve(waiter, buildTerminalWaitResult(handle, 'exit', leaf))
      } else {
        // Why: after exit, conditions like tui-idle can never be satisfied — reject now instead of spinning the poll until timeout on a dead process.
        this.terminalWaiters.remove(waiter)
        waiter.reject(new Error('terminal_exited'))
      }
    }
  }

  resolveTuiIdleWaiters(leaf: RuntimeLeafRecord): void {
    const leafKey = this.host.getLeafKey(leaf.tabId, leaf.leafId)
    const candidateHandle =
      this.host.getLeafHandle(leafKey) ??
      (leaf.ptyId
        ? (this.host.getPtyHandle(leaf.ptyId) ?? this.host.getPtyIncarnationHandle(leaf.ptyId))
        : undefined)
    if (!candidateHandle || !this.terminalWaiters.get(candidateHandle)?.size) {
      return
    }
    const handle = candidateHandle
    const waiters = this.terminalWaiters.get(handle)
    if (!waiters || waiters.size === 0) {
      return
    }
    // Why re-rank rather than resolve outright: the transition that brought us here is only a
    // title sample. Weak ready (a name-only title, #6011) cannot see a dialog the tail lost,
    // so it is left to the poll, which settles it only after a rendered-screen read.
    const verdict = this.evaluateTuiIdleForLeaf(leaf)
    for (const waiter of Array.from(waiters)) {
      if (waiter.condition !== 'tui-idle') {
        continue
      }
      if (verdict.kind === 'blocked') {
        this.terminalWaiters.resolve(
          waiter,
          buildTerminalWaitBlockedResult(handle, 'tui-idle', leaf, verdict.reason)
        )
      } else if (verdict.kind === 'ready-strong') {
        this.terminalWaiters.resolve(waiter, buildTerminalWaitResult(handle, 'tui-idle', leaf))
      }
    }
  }

  resolvePtyExitWaiters(pty: RuntimePtyWorktreeRecord, ptyId: string): void {
    const handle = this.host.getPtyHandle(ptyId)
    if (!handle) {
      return
    }
    const waiters = this.terminalWaiters.get(handle)
    if (!waiters || waiters.size === 0) {
      return
    }
    for (const waiter of Array.from(waiters)) {
      if (waiter.condition === 'exit') {
        this.terminalWaiters.resolve(waiter, buildPtyTerminalWaitResult(handle, 'exit', pty))
      } else {
        this.terminalWaiters.remove(waiter)
        waiter.reject(new Error('terminal_exited'))
      }
    }
  }

  resolvePtyTuiIdleWaiters(pty: RuntimePtyWorktreeRecord, ptyId: string): void {
    const handle = this.host.getPtyHandle(ptyId)
    if (!handle) {
      return
    }
    const waiters = this.terminalWaiters.get(handle)
    if (!waiters || waiters.size === 0) {
      return
    }
    // Why: same re-ranking as resolveTuiIdleWaiters above.
    const verdict = this.evaluateTuiIdleForPty(pty)
    for (const waiter of Array.from(waiters)) {
      if (waiter.condition !== 'tui-idle') {
        continue
      }
      if (verdict.kind === 'blocked') {
        this.terminalWaiters.resolve(
          waiter,
          buildPtyTerminalWaitBlockedResult(handle, 'tui-idle', pty, verdict.reason)
        )
      } else if (verdict.kind === 'ready-strong') {
        this.terminalWaiters.resolve(waiter, buildPtyTerminalWaitResult(handle, 'tui-idle', pty))
      }
    }
  }

  evaluateTuiIdleForLeaf(leaf: RuntimeLeafRecord): TuiIdleVerdict {
    return evaluateTuiIdle(
      leafTuiIdleEvidence(this.tuiIdleEvidenceSource, leaf, () =>
        buildTerminalWaitText(leaf.tailBuffer, leaf.tailPartialLine, leaf.preview)
      )
    )
  }

  evaluateTuiIdleForPty(pty: RuntimePtyWorktreeRecord): TuiIdleVerdict {
    return evaluateTuiIdle(
      ptyTuiIdleEvidence(this.tuiIdleEvidenceSource, pty, () =>
        buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview)
      )
    )
  }

  getAdoptedPtyExplicitIdleStatus(pty: RuntimePtyWorktreeRecord): AgentStatus | null {
    const title = pty.lastOscTitle ?? this.getAdoptedPtyTitle(pty)
    return title ? detectExplicitIdleStatusFromTitle(title) : null
  }

  getAdoptedPtyTitle(pty: RuntimePtyWorktreeRecord): string | null {
    for (const leaf of this.host.getLeaves()) {
      if (leaf.ptyId !== pty.ptyId) {
        continue
      }
      const title = leaf.paneTitle ?? this.host.getTabTitle(leaf.tabId)
      if (!title) {
        continue
      }
      return title
    }
    return null
  }
}
