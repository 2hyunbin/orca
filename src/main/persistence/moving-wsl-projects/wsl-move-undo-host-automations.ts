/**
 * Undo's automation step. A released move's automations run here again, so every one of the
 * move's host copies that is on turns off first, and the copy here takes the host's state, the
 * user's latest choice: each runs in exactly one place. A refused undo turns back on what it
 * turned off and changes nothing here; one it cannot turn back on is recorded, shown and retried.
 */
import type { Automation } from '../../../shared/automations-types'
import { listWslMoveCutovers, writeWslMoveCutover } from './wsl-move-cutover-journal'

export type WslMoveHostAutomationStop =
  | {
      outcome: 'stopped'
      /** A later undo step refused: turn back on what this attempt turned off on the host. */
      restore: () => Promise<void>
      /** With the release: the copies here take the host's state. */
      applyHere: () => void
    }
  | { outcome: 'unreachable' | 'failed' | 'removal-pending' }

type HostAutomationsTurnedOff = { turnedOff: string[]; hostEnabled: Record<string, boolean> }

/** Every automation the move carried, whatever its state here or on the host. */
export function wslMoveMovedAutomationIds(move: {
  manifest: { payload: { dormantState?: { automations?: readonly { id: string }[] } } }
}): string[] {
  return (move.manifest.payload.dormantState?.automations ?? []).map(({ id }) => id)
}

/** The copies here whose `enabled` differs from the host's. */
export function wslMoveLocalAutomationStateUpdates(
  localAutomations: readonly Pick<Automation, 'id' | 'enabled'>[],
  hostEnabled: Readonly<Record<string, boolean>>
): { id: string; enabled: boolean }[] {
  return localAutomations.flatMap((automation) => {
    const enabled = hostEnabled[automation.id]
    return enabled === undefined || enabled === automation.enabled
      ? []
      : [{ id: automation.id, enabled }]
  })
}

/** A host that answered but refused is `failed`; anything else that throws is `unreachable`. */
export async function stopWslMoveHostAutomations(
  automationIds: readonly string[],
  host: {
    disable: (automationIds: readonly string[]) => Promise<HostAutomationsTurnedOff>
    /** Turns these on unconditionally: this attempt turned them off. */
    restore: (automationIds: readonly string[]) => Promise<void>
    leftOff: (automationIds: readonly string[]) => void
    applyHere: (hostEnabled: Readonly<Record<string, boolean>>) => void
  }
): Promise<WslMoveHostAutomationStop> {
  if (automationIds.length === 0) {
    return { outcome: 'stopped', restore: async () => {}, applyHere: () => {} }
  }
  let result: HostAutomationsTurnedOff
  try {
    result = await host.disable(automationIds)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { outcome: message.startsWith('wsl_move_automation_') ? 'failed' : 'unreachable' }
  }
  return {
    outcome: 'stopped',
    restore: async () => {
      try {
        await host.restore(result.turnedOff)
      } catch (error) {
        console.warn('[wsl-move] Could not turn host automations back on:', error)
        host.leftOff(result.turnedOff)
      }
    },
    applyHere: () => host.applyHere(result.hostEnabled)
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
    } catch {
      remaining = true
      continue
    }
    // Fresh after the host round trip: an undo may have released the move, or a pass advanced it.
    const current = listWslMoveCutovers(userDataPath).find(
      (entry) => entry.migrationId === cutover.migrationId
    )
    if (!current) {
      continue
    }
    const restored = new Set(ids)
    const left = (current.hostAutomationsLeftOff ?? []).filter((id) => !restored.has(id))
    const { hostAutomationsLeftOff: _done, ...rest } = current
    writeWslMoveCutover(
      userDataPath,
      left.length > 0 ? { ...rest, hostAutomationsLeftOff: left } : rest
    )
    remaining ||= left.length > 0
  }
  return remaining
}
