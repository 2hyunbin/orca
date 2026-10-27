/**
 * Undo's host step for automations: a released move's automations run here again, so the host's
 * copies turn off first, or each would run twice, once on each side of the same files. What each
 * was on the host comes back with them, as the user's latest choice.
 */
import {
  AUTOMATION_NOT_FOUND,
  ShownAutomationSchema,
  openWslHostAutomationApi,
  type WslHostAutomationApi
} from './wsl-host-automation-enable'

export type WslHostAutomationsTurnedOff = {
  turnedOff: string[]
  /** Each one's state on the host before this call, the user's latest; one deleted there is off. */
  hostEnabled: Record<string, boolean>
}

/**
 * Turns off each one the host has on and reports what each was. Throws unless the host answered
 * for every one, after turning back on the ones it had turned off.
 */
export async function disableWslHostAutomations(
  userDataPath: string,
  environmentId: string,
  automationIds: readonly string[]
): Promise<WslHostAutomationsTurnedOff> {
  const hostEnabled: Record<string, boolean> = {}
  if (automationIds.length === 0) {
    return { turnedOff: [], hostEnabled }
  }
  const request = await openWslHostAutomationApi(userDataPath, environmentId)
  const turnedOff: string[] = []
  try {
    for (const id of automationIds) {
      const shown = await request('automation.show', { id })
      if (!shown.ok) {
        if (shown.error.message.includes(AUTOMATION_NOT_FOUND)) {
          hostEnabled[id] = false
          continue
        }
        throw new Error(`wsl_move_automation_read_failed:${shown.error.message}`)
      }
      hostEnabled[id] = ShownAutomationSchema.parse(shown.result).automation.enabled
      if (!hostEnabled[id]) {
        continue
      }
      const updated = await request('automation.update', { id, updates: { enabled: false } })
      if (!updated.ok) {
        throw new Error(`wsl_move_automation_disable_failed:${updated.error.message}`)
      }
      turnedOff.push(id)
    }
  } catch (error) {
    // A refused undo leaves the host as it found it (X1).
    await turnOn(request, turnedOff).catch((restoreError: unknown) => {
      console.warn('[wsl-move] Could not turn host automations back on:', restoreError)
    })
    throw error
  }
  return { turnedOff, hostEnabled }
}

/** Turns back on what disableWslHostAutomations turned off, when undo then refuses. */
export async function restoreWslHostAutomations(
  userDataPath: string,
  environmentId: string,
  automationIds: readonly string[]
): Promise<void> {
  if (automationIds.length > 0) {
    await turnOn(await openWslHostAutomationApi(userDataPath, environmentId), automationIds)
  }
}

async function turnOn(request: WslHostAutomationApi, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    const updated = await request('automation.update', { id, updates: { enabled: true } })
    if (!updated.ok) {
      throw new Error(`wsl_move_automation_enable_failed:${updated.error.message}`)
    }
  }
}
