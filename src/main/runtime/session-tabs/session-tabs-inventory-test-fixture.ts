import type { OrcaRuntimeService } from '../orca-runtime'
import { SessionTabsInventoryPublication } from './session-tabs-inventory-publication'

export function getSessionTabsInventoryPublication(
  runtime: OrcaRuntimeService
): SessionTabsInventoryPublication {
  const owner: unknown = Object.getOwnPropertyDescriptor(
    runtime,
    'sessionTabsInventoryPublication'
  )?.value
  if (!(owner instanceof SessionTabsInventoryPublication)) {
    throw new Error('Runtime does not own a session tab inventory publication')
  }
  return owner
}
