/**
 * Undo's host step for automations: a released move's automations run here again, so the host's
 * copies turn off first, or each would run twice, once on each side of the same files.
 */
import {
  AUTOMATION_NOT_FOUND,
  ShownAutomationSchema,
  openWslHostAutomationApi,
  type WslHostAutomationApi
} from './wsl-host-automation-enable'

/**
 * Returns the ids it turned off; one the host no longer has, or has off, is left alone. Throws
 * unless the host answered for every one, after turning back on the ones it had turned off.
 */
export async function disableWslHostAutomations(
  userDataPath: string,
  environmentId: string,
  automationIds: readonly string[]
): Promise<string[]> {
  if (automationIds.length === 0) {
    return []
  }
  const request = await openWslHostAutomationApi(userDataPath, environmentId)
  const turnedOff: string[] = []
  try {
    for (const id of automationIds) {
      const shown = await request('automation.show', { id })
      if (!shown.ok) {
        if (shown.error.message.includes(AUTOMATION_NOT_FOUND)) {
          continue
        }
        throw new Error(`wsl_move_automation_read_failed:${shown.error.message}`)
      }
      if (!ShownAutomationSchema.parse(shown.result).automation.enabled) {
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
  return turnedOff
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
