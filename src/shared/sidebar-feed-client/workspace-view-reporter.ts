import type { ExecutionHostId } from '../execution-host'
import type { ClientWorkspaceView } from '../rpc-contract/client-workspace-view-params'
import {
  composeWorktreeHostIdentity,
  type HostScopedWorktreeKey
} from '../worktree/host-qualified-identity'

/** A tab on one host: the same tab id on another host is another tab. */
export type HostScopedTabKey = `${ExecutionHostId}|${string}`

export function hostScopedTabKey(hostId: ExecutionHostId, tabId: string): HostScopedTabKey {
  return `${hostId}|${tabId}`
}

/** What a client shows its user right now; empty while it is hidden or in the background. */
export type ClientView = {
  workspaces: readonly { hostId: ExecutionHostId; worktreeId: string }[]
  tabs: readonly { hostId: ExecutionHostId; tabId: string }[]
}

/** Today's report plus its order and host-qualified targets; a host that predates them reads the ids. */
export type ClientViewReport = ClientWorkspaceView & {
  seq: number
  workspaceKeys: HostScopedWorktreeKey[]
  tabKeys: HostScopedTabKey[]
}

/**
 * One client's `reportView` stream. Each report replaces the last and carries a higher `seq`, so
 * a receiver drops one that arrives late. On reconnect the last report is sent again with what is
 * left of its presence lease, never a fresh lease.
 */
export class WorkspaceViewReporter {
  private seq = 0
  private last: { view: ClientView; presentUntil: number | null } | null = null

  constructor(
    private readonly send: (report: ClientViewReport) => void,
    private readonly now: () => number
  ) {}

  /** `presentForMs`: how long the user stays present without new input; null where untracked. */
  report(view: ClientView, presentForMs: number | null): void {
    this.last = { view, presentUntil: presentForMs === null ? null : this.now() + presentForMs }
    this.send(this.build(view, presentForMs))
  }

  /** The connection came back: the receiver lost the view, so it gets the last one again. */
  reconnected(): void {
    if (!this.last) {
      return
    }
    const { view, presentUntil } = this.last
    this.send(
      this.build(view, presentUntil === null ? null : Math.max(0, presentUntil - this.now()))
    )
  }

  private build(view: ClientView, presentForMs: number | null): ClientViewReport {
    this.seq += 1
    return {
      seq: this.seq,
      workspaceIds: view.workspaces.map((workspace) => workspace.worktreeId),
      tabIds: view.tabs.map((tab) => tab.tabId),
      workspaceKeys: view.workspaces.map((workspace) =>
        composeWorktreeHostIdentity(workspace.hostId, workspace.worktreeId)
      ),
      tabKeys: view.tabs.map((tab) => hostScopedTabKey(tab.hostId, tab.tabId)),
      presentForMs
    }
  }
}

type FencedView = { seq: number; workspaceKeys: ReadonlySet<string>; tabKeys: ReadonlySet<string> }

/** The receiving side: the newest report per connection, and what each one newly shows. */
export class WorkspaceViewReportFence {
  private readonly byConnection = new Map<string, FencedView>()

  /** Null for a report older than (or the same as) the connection's newest; else its new targets. */
  accept(
    connectionId: string,
    report: Pick<ClientViewReport, 'seq' | 'workspaceKeys' | 'tabKeys'>
  ): { workspaceKeys: HostScopedWorktreeKey[]; tabKeys: HostScopedTabKey[] } | null {
    const previous = this.byConnection.get(connectionId)
    if (previous && report.seq <= previous.seq) {
      return null
    }
    this.byConnection.set(connectionId, {
      seq: report.seq,
      workspaceKeys: new Set(report.workspaceKeys),
      tabKeys: new Set(report.tabKeys)
    })
    return {
      workspaceKeys: report.workspaceKeys.filter((key) => !previous?.workspaceKeys.has(key)),
      tabKeys: report.tabKeys.filter((key) => !previous?.tabKeys.has(key))
    }
  }

  forget(connectionId: string): void {
    this.byConnection.delete(connectionId)
  }
}
