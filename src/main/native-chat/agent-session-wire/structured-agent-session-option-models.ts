// The models a session's options answer lists, the same whether a child answers live or the host
// answers for a chat at rest: the catalog's rows, plus the current model when the catalog does not
// list it. A known current effort remains a scalar unless the exact current child reports its menu.

import type {
  AgentSessionModelCatalogResult,
  AgentSessionModelOption,
  AgentSessionOptionsResult
} from '../../../shared/agent-session-wire'

/** A selected-only row is presentation for this chat, never shared discovery. */
export function structuredAgentSessionSelectedCatalog(
  catalog: AgentSessionModelCatalogResult,
  selected: string | undefined
): AgentSessionModelCatalogResult {
  return catalog.origin === 'unknown'
    ? catalog
    : {
        ...catalog,
        models: structuredAgentSessionOptionModels(catalog.models, selected, (row) => row)
      }
}

/** `row` builds a provider's own row type from the shared one. */
export function structuredAgentSessionOptionModels<TModel extends AgentSessionModelOption>(
  catalog: readonly TModel[],
  current: string | undefined,
  row: (unlisted: AgentSessionModelOption) => TModel
): TModel[] {
  const models = [...catalog]
  if (current && !models.some((entry) => entry.id === current)) {
    models.push(
      row({ id: current, label: current, isDefault: false, efforts: [], effortsKnown: false })
    )
  }
  return models
}

/** Session-only projection: child controls describe only the exact selected model. */
export function structuredAgentSessionCurrentModelOptions(
  result: AgentSessionOptionsResult,
  live: AgentSessionOptionsResult | null
): AgentSessionOptionsResult {
  const current = result.current
  result.models = structuredAgentSessionOptionModels(result.models, current.model, (row) => row)
  // Only the exact current row describes this child's controls; no aliases or sibling rows.
  const currentRow =
    live && live.current.model === current.model
      ? live.models.find((row) => row.id === current.model)
      : undefined
  if (currentRow) {
    result.fastModeSupport = live?.fastModeSupport
    result.models = result.models.map((row) =>
      row.id === current.model
        ? {
            ...row,
            ...(currentRow.effortsKnown !== false
              ? {
                  efforts: currentRow.efforts,
                  defaultEffort: currentRow.defaultEffort,
                  effortsKnown: undefined
                }
              : {}),
            supportsFastMode: currentRow.supportsFastMode,
            serviceTiers: currentRow.serviceTiers
          }
        : row
    )
  }
  if (result.listedModelIds?.length) {
    result.listedModelIds = result.models.map((row) => row.id)
  }
  return result
}
