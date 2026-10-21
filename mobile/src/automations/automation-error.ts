import {
  automationOwnerConflictMessage,
  matchAutomationOwnerConflict
} from '../../../src/shared/automation-owner-conflict'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'

export const AUTOMATION_OUTCOME_UNKNOWN =
  'The host may have applied this action. Refresh to check before trying again.'

export function automationErrorMessage(error: unknown): string {
  if (isRpcDeliveryUnknown(error)) {
    return AUTOMATION_OUTCOME_UNKNOWN
  }
  const conflict = matchAutomationOwnerConflict(error)
  if (conflict) {
    return automationOwnerConflictMessage(conflict)
  }
  const message = error instanceof Error ? error.message : ''
  if (/forbidden|method_not_found/.test(message)) {
    return 'Automations are unavailable on this host. Update Orca on that host and reconnect.'
  }
  if (/disconnect|connection|cutover|closed|timeout/i.test(message)) {
    return 'Could not reach this host. Reconnect, then refresh to check its current state.'
  }
  return 'Could not complete this action on the host. Refresh and try again.'
}
