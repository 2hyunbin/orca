import { DESKTOP_PRESENCE_TTL_MS } from '../../shared/desktop-client-presence'

/** The last presence each attached desktop connection reported to this host. */
export class DesktopClientPresenceTracker {
  private readonly reports = new Map<string, { away: boolean; at: number }>()

  /** Returns true when this connection had no report yet, so the caller can bind its cleanup. */
  report(connectionId: string, away: boolean, now: number): boolean {
    const isNew = !this.reports.has(connectionId)
    this.reports.set(connectionId, { away, at: now })
    return isNew
  }

  forget(connectionId: string): void {
    this.reports.delete(connectionId)
  }

  /** True only on a fresh "present" report; silence, staleness and older desktops read as away. */
  anyPresent(now: number): boolean {
    for (const { away, at } of this.reports.values()) {
      if (!away && now - at < DESKTOP_PRESENCE_TTL_MS) {
        return true
      }
    }
    return false
  }
}
