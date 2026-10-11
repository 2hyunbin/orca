import type { RuntimeGraphStatus, RuntimeSyncedTab } from '../../../shared/runtime-types'
import type { RuntimeLeafRecord } from '../runtime-terminal-state-records'

export class RuntimeGraphState {
  rendererGraphEpoch = 0

  graphStatus: RuntimeGraphStatus = 'unavailable'

  authoritativeWindowId: number | null = null

  headlessGraphFallbackAvailable = false

  pendingHeadlessPromotionWindowId: number | null = null

  rendererGeneration: string | null = null

  tabs = new Map<string, RuntimeSyncedTab>()

  graphSequence = 0

  leaves = new Map<string, RuntimeLeafRecord>()

  leavesByPtyId = new Map<string, RuntimeLeafRecord[]>()

  constructor(private readonly getDetachedLeaves: () => Map<string, RuntimeLeafRecord>) {}

  get detachedPreAllocatedLeaves(): Map<string, RuntimeLeafRecord> {
    return this.getDetachedLeaves()
  }

  graphSyncCallbacks: (() => void)[] = []

  rebuildLeafPtyIndex(): void {
    const next = new Map<string, RuntimeLeafRecord[]>()
    for (const leaf of this.leaves.values()) {
      if (!leaf.ptyId) {
        continue
      }
      const leaves = next.get(leaf.ptyId)
      if (leaves) {
        leaves.push(leaf)
      } else {
        next.set(leaf.ptyId, [leaf])
      }
    }
    this.leavesByPtyId = next
  }
}
