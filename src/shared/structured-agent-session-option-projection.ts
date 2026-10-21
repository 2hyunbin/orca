import type { AgentSessionModelCatalogResult } from './agent-session-wire'

/** Raw capability input only: display text, age and transport progress do not invalidate controls. */
export function structuredAgentSessionInventoryKey(
  catalog: AgentSessionModelCatalogResult | null
): string | null {
  if (!catalog || catalog.origin === 'unknown' || catalog.unavailable) {
    return null
  }
  return JSON.stringify([
    catalog.listingNamesConfiguredModel,
    catalog.defaultHoldsInEveryWorkspace,
    catalog.modelsDifferByWorkspace,
    catalog.fastModeSupport?.supported,
    catalog.models
      .map((row) =>
        JSON.stringify([
          row.id,
          row.isDefault,
          row.resolvedModel,
          row.effortsKnown,
          row.defaultEffort,
          row.efforts.map((choice) => choice.value).sort(),
          row.serviceTiers?.map((choice) => choice.value).sort(),
          row.supportsFastMode,
          row.supportsAutoMode
        ])
      )
      .sort()
  ])
}

type OptionProjection = {
  key: string | null
  revision: number
  accepted: number
  initial: boolean
  writes: number
  pendingRead: boolean
}

export function createStructuredAgentSessionOptionProjection(): OptionProjection {
  return { key: null, revision: 0, accepted: 0, initial: false, writes: 0, pendingRead: false }
}

/** Advances the local reader dependency before the receipt can update presentation. */
export function observeStructuredAgentSessionInventory(
  projection: OptionProjection,
  catalog: AgentSessionModelCatalogResult | null
): boolean {
  const key = structuredAgentSessionInventoryKey(catalog)
  const changed = key !== null && key !== projection.key
  if (changed) {
    projection.key = key
    projection.revision += 1
  }
  projection.initial = true
  return changed
}
