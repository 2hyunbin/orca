// Layout-owner builds: the pane each handle was resolved for. Main's layout names no pane for a
// terminal a replacement unbound, so recovery needs this to tell a stale handle's own pane (L80).
import { pruneOldestMapEntry } from '../../prune-oldest-map-entry'

const MAX_RESOLVED_PANE_HANDLES = 512

export class ResolvedPaneHandles {
  private readonly paneKeyByHandle = new Map<string, string>()

  note(handle: string, paneKey: string): void {
    this.paneKeyByHandle.delete(handle)
    this.paneKeyByHandle.set(handle, paneKey)
    pruneOldestMapEntry(this.paneKeyByHandle, MAX_RESOLVED_PANE_HANDLES)
  }

  paneKeyOf(handle: string): string | undefined {
    return this.paneKeyByHandle.get(handle)
  }
}
