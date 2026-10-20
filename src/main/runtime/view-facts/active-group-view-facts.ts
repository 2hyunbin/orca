// The tab group each workspace shows, as the window and each paired desktop last reported it: a
// view fact, kept in memory only. Main opens a CLI or phone file in the group of whichever of them
// reported that workspace last; with none, in the saved view's. A closed connection's reports go
// with it. A removed workspace's entry stays: a stale group is refused and the open falls back to
// main's rule.

type Reported = { groupId: string | null; order: number }

export class ActiveGroupViewFacts {
  /** Workspace key → the group the window shows; null when it shows none. */
  private readonly fromWindow = new Map<string, Reported>()
  /** Paired desktop connection id → its reports, as the window's. */
  private readonly fromClients = new Map<string, Map<string, Reported>>()
  private order = 0

  /** A window's report: each named workspace's entry replaces the last; others are kept. */
  merge(report: Readonly<Record<string, string | null>> | undefined): void {
    this.record(this.fromWindow, report)
  }

  /** A paired desktop's report, as the window's; true when it is the connection's first. */
  mergeFromClient(connectionId: string, report: Readonly<Record<string, string | null>>): boolean {
    const known = this.fromClients.get(connectionId)
    const reports = known ?? new Map<string, Reported>()
    this.fromClients.set(connectionId, reports)
    this.record(reports, report)
    return known === undefined
  }

  dropClient(connectionId: string): void {
    this.fromClients.delete(connectionId)
  }

  /** The latest report's group, else the saved view's (after a restart no one has reported yet). */
  groupFor(workspace: string, savedGroupId: () => string | null | undefined): string | undefined {
    let latest = this.fromWindow.get(workspace)
    for (const reports of this.fromClients.values()) {
      const reported = reports.get(workspace)
      if (reported && (!latest || reported.order > latest.order)) {
        latest = reported
      }
    }
    const groupId = latest ? latest.groupId : savedGroupId()
    return groupId ?? undefined
  }

  private record(
    into: Map<string, Reported>,
    report: Readonly<Record<string, string | null>> | undefined
  ): void {
    for (const [workspace, groupId] of Object.entries(report ?? {})) {
      into.set(workspace, { groupId, order: ++this.order })
    }
  }
}
