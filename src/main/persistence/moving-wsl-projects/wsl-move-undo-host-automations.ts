/**
 * Undo's automation step. A released move's automations run here again, so the host's copies must
 * be off first: both sides would run them against the same files. Only automations whose copy here
 * is on can double-run; one off here keeps whatever the user chose on the host. A refused undo
 * turns back on what it turned off; one it cannot is recorded, shown and retried.
 */
import type { Automation } from '../../../shared/automations-types'
import { listWslMoveCutovers, writeWslMoveCutover } from './wsl-move-cutover-journal'

export type WslMoveHostAutomationStop =
  /** `restore` turns back on what this attempt turned off, when a later undo step refuses. */
  | { outcome: 'stopped'; restore: () => Promise<void> }
  | { outcome: 'unreachable' | 'failed' | 'removal-pending' }

/** The released move's own automations that are on here; none of another move's. */
export function wslMoveAutomationsToTurnOffOnHost(
  move: { manifest: { payload: { dormantState?: { automations?: readonly { id: string }[] } } } },
  localAutomations: readonly Pick<Automation, 'id' | 'enabled'>[]
): string[] {
  const moved = new Set(move.manifest.payload.dormantState?.automations?.map(({ id }) => id))
  return localAutomations
    .filter((automation) => automation.enabled && moved.has(automation.id))
    .map(({ id }) => id)
}

/** A host that answered but refused is `failed`; anything else that throws is `unreachable`. */
export async function stopWslMoveHostAutomations(
  automationIds: readonly string[],
  host: {
    disable: (automationIds: readonly string[]) => Promise<string[]>
    /** Turns these on unconditionally: this attempt turned them off. */
    restore: (automationIds: readonly string[]) => Promise<void>
    leftOff: (automationIds: readonly string[]) => void
  }
): Promise<WslMoveHostAutomationStop> {
  if (automationIds.length === 0) {
    return { outcome: 'stopped', restore: async () => {} }
  }
  try {
    const turnedOff = await host.disable(automationIds)
    return {
      outcome: 'stopped',
      restore: async () => {
        try {
          await host.restore(turnedOff)
        } catch (error) {
          console.warn('[wsl-move] Could not turn host automations back on:', error)
          host.leftOff(turnedOff)
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { outcome: message.startsWith('wsl_move_automation_') ? 'failed' : 'unreachable' }
  }
}

/** Adds to the move's record what a refused undo left off on the host. */
export function recordWslMoveHostAutomationsLeftOff(
  userDataPath: string,
  migrationId: string,
  automationIds: readonly string[]
): void {
  const cutover = listWslMoveCutovers(userDataPath).find(
    (entry) => entry.migrationId === migrationId
  )
  if (!cutover || automationIds.length === 0) {
    return
  }
  const leftOff = [...new Set([...(cutover.hostAutomationsLeftOff ?? []), ...automationIds])]
  writeWslMoveCutover(userDataPath, { ...cutover, hostAutomationsLeftOff: leftOff.sort() })
}

/** Turns back on what refused undos left off; true while any is still left off. */
export async function retryWslMoveHostAutomationsLeftOff(
  userDataPath: string,
  restore: (environmentId: string, automationIds: readonly string[]) => Promise<void>
): Promise<boolean> {
  let remaining = false
  for (const cutover of listWslMoveCutovers(userDataPath)) {
    const ids = cutover.hostAutomationsLeftOff ?? []
    if (ids.length === 0) {
      continue
    }
    try {
      await restore(cutover.destinationEnvironmentId, ids)
      const { hostAutomationsLeftOff: _done, ...rest } = cutover
      writeWslMoveCutover(userDataPath, rest)
    } catch {
      remaining = true
    }
  }
  return remaining
}
