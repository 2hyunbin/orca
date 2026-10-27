/**
 * Undo's automation step. A released move's automations run here again, so the host's copies must
 * be off first: both sides would run them against the same files. Only automations whose copy here
 * is on can double-run; one off here keeps whatever the user chose on the host.
 */
import type { Automation } from '../../../shared/automations-types'

export type WslMoveHostAutomationStop =
  /** `restore` turns back on what was turned off, when a later undo step refuses. */
  { outcome: 'stopped'; restore: () => Promise<void> } | { outcome: 'unreachable' | 'failed' }

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
    restore: (automationIds: readonly string[]) => Promise<void>
  }
): Promise<WslMoveHostAutomationStop> {
  if (automationIds.length === 0) {
    return { outcome: 'stopped', restore: async () => {} }
  }
  try {
    const turnedOff = await host.disable(automationIds)
    return { outcome: 'stopped', restore: () => host.restore(turnedOff) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { outcome: message.startsWith('wsl_move_automation_') ? 'failed' : 'unreachable' }
  }
}
