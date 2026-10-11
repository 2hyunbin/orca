import { ipcMain } from 'electron'
import {
  CREATE_LOCAL_PAIRING_TICKET_CHANNEL,
  PAIRING_APPROVAL_ANSWER_CHANNEL,
  PairingApprovalAnswerSchema,
  type LocalPairingTicketResult
} from '../../shared/pairing-approval-prompt'
import { NETWORK_EXPOSURE_FAILED_GUIDANCE } from '../runtime/network-exposure-guidance'
import type { PairingApprovalBroker } from '../runtime/pairing-approval-broker'
import {
  getDefaultPairingAddress,
  type DefaultRouteInterfaceLookup
} from '../runtime/pairing-network-interfaces'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { getWindowsDefaultRouteInterfaceNames } from '../runtime/windows-default-route-interfaces'

type PairingTicketRuntime = Pick<
  OrcaRuntimeRpcServer,
  'createLocalUiPairingTicket' | 'ensureNetworkExposure'
>

export function registerPairingTicketHandlers(
  runtime: PairingTicketRuntime,
  broker: PairingApprovalBroker,
  deps: {
    // Why: only the main window may approve a pairing; any other renderer is refused.
    isTrustedSender: (event: { sender: unknown }) => boolean
    getDefaultRouteInterfaceNames?: DefaultRouteInterfaceLookup
  }
): void {
  ipcMain.handle(PAIRING_APPROVAL_ANSWER_CHANNEL, (event, args: unknown): boolean => {
    const answer = PairingApprovalAnswerSchema.safeParse(args)
    return deps.isTrustedSender(event) && answer.success && broker.answer(answer.data)
  })

  ipcMain.handle(
    CREATE_LOCAL_PAIRING_TICKET_CHANNEL,
    async (event, args?: { address?: unknown }): Promise<LocalPairingTicketResult> => {
      if (!deps.isTrustedSender(event)) {
        return { available: false }
      }
      const address =
        typeof args?.address === 'string' && args.address.length > 0
          ? args.address
          : await getDefaultPairingAddress(
              deps.getDefaultRouteInterfaceNames ?? getWindowsDefaultRouteInterfaceNames
            )
      if (!address) {
        return { available: false }
      }
      // Why: a ticket is for another machine's browser, so the listener must be reachable off-host.
      try {
        await runtime.ensureNetworkExposure()
      } catch (error) {
        console.error('[pairing] Network exposure failed while minting a pairing ticket:', error)
        return { available: false, guidance: NETWORK_EXPOSURE_FAILED_GUIDANCE }
      }
      return runtime.createLocalUiPairingTicket(address)
    }
  )
}
