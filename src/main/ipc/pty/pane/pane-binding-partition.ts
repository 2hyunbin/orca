import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { Store } from '../../../persistence'

/**
 * Switch point: main keeps its own layout over a window save, so an SSH pane binds in the
 * partition its layout lives in, not in `local`.
 */
export function persistPaneBinding(
  store: Pick<Store, 'persistPtyBinding'>,
  binding: Parameters<Store['persistPtyBinding']>[0],
  connectionId: string | null | undefined
): Promise<boolean> {
  return ORCA_LAYOUT_OWNER_IS_MAIN && connectionId
    ? store.persistPtyBinding(binding, toSshExecutionHostId(connectionId))
    : store.persistPtyBinding(binding)
}
