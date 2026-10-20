// Each pane's binding generation (`LayoutLeaf.ptyGeneration`): it rises on every write of the
// pane's binding in this process, a respawn under the same terminal id included, so a reader can
// tell a new terminal from the one it attached. In memory only; layout-owner builds only.

import type { ExecutionHostId } from '../../../shared/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type { StoreRuntimeState } from './store-runtime-state'

type GenerationRuntime = Pick<StoreRuntimeState, 'ptyBindingGenerations'>

const generationKey = (hostId: ExecutionHostId, leafId: string) => `${hostId}\0${leafId}`

export function bumpPtyBindingGeneration(
  runtime: GenerationRuntime,
  hostId: ExecutionHostId,
  leafId: string
): void {
  // Switch point: a window-owned build publishes no generation, so it counts none.
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return
  }
  const key = generationKey(hostId, leafId)
  runtime.ptyBindingGenerations.set(key, (runtime.ptyBindingGenerations.get(key) ?? 0) + 1)
}

/** Undefined for a pane whose binding this process never wrote. */
export function ptyBindingGenerationOf(
  runtime: GenerationRuntime,
  hostId: ExecutionHostId,
  leafId: string
): number | undefined {
  return runtime.ptyBindingGenerations.get(generationKey(hostId, leafId))
}
