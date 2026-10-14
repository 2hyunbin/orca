import {
  createManagedOrcadActions as createHostActions,
  type ManagedOrcadActionOptions as HostOptions
} from '../ssh/managed-orcad-actions'
import { retireRemovedRuntimeEnvironment } from './runtime-environment-removal-cleanup'
export type ManagedOrcadActionOptions = Omit<HostOptions, 'retireLocalState'>

export function createManagedOrcadActions(options: ManagedOrcadActionOptions) {
  return createHostActions({
    ...options,
    retireLocalState: (environmentId) =>
      retireRemovedRuntimeEnvironment(environmentId, options.invalidateTransport, options.store)
  })
}
