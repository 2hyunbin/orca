/**
 * Undo's host step for automations: a released move's automations go back to running here, so the
 * host's copies turn off first, or each would run twice, once on each side of the same files.
 */
import {
  AUTOMATION_NOT_FOUND,
  ShownAutomationSchema,
  openWslHostAutomationApi
} from './wsl-host-automation-enable'

/** Throws unless the host answered for every one; one it no longer has, or has off, is done. */
export async function disableWslHostAutomations(
  userDataPath: string,
  environmentId: string,
  automationIds: readonly string[]
): Promise<void> {
  if (automationIds.length === 0) {
    return
  }
  const request = await openWslHostAutomationApi(userDataPath, environmentId)
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
  }
}
