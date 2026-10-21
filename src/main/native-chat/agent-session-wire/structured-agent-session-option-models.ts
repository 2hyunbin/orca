// The models a session's options answer lists, the same whether a child answers live or the host
// answers for a chat at rest: the catalog's rows, plus the current model when the catalog does not
// list it. Nothing says which efforts an unlisted model takes, so its row offers none.

import type {
  AgentSessionModelOption,
  AgentSessionOptionsResult
} from '../../../shared/agent-session-wire'
import type { AgentModelCatalogLiveListing } from '../agent-model-catalog/agent-model-catalog-entry'

export type StructuredAgentSessionOptionProjection = {
  models: readonly AgentSessionModelOption[]
  options: Readonly<Record<string, string>>
}

/** Only provider acquisition constructs this; rendered rows cannot serve as child evidence. */
export type StructuredAgentCurrentModelObservation = {
  source: 'claude-child' | 'codex-child'
  model: string
  capabilities: {
    effort?: { choices: AgentSessionModelOption['efforts']; default?: string }
    tiers?: AgentSessionModelOption['serviceTiers']
    fast?: boolean
  }
}

/** A live options read, plus what the child listed for its account's saved catalog. The host
 *  saves that listing and strips it before answering; an adapter whose listing reaches the
 *  catalog another way omits it. */
export type StructuredAgentSessionLiveOptions = AgentSessionOptionsResult & {
  catalogListing?: AgentModelCatalogLiveListing
  currentModelObservation?: StructuredAgentCurrentModelObservation
  fastModeRestriction?: AgentSessionOptionsResult['fastModeSupport']
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

/** One-way composition: inventory owns alternatives; a child owns only reported current groups. */
export function structuredAgentSessionCapabilityView(
  installed:
    | {
        models: readonly AgentSessionModelOption[]
        fastModeSupport?: AgentSessionOptionsResult['fastModeSupport']
      }
    | { origin: 'unknown' },
  current: string | undefined,
  child?: StructuredAgentCurrentModelObservation,
  fallback: readonly AgentSessionModelOption[] = [],
  restriction?: AgentSessionOptionsResult['fastModeSupport']
): {
  models: AgentSessionModelOption[]
  fastModeSupport?: AgentSessionOptionsResult['fastModeSupport']
  listedServiceTiers: readonly string[]
} {
  const inventory = 'models' in installed ? installed : { models: [] }
  const eligible = child?.model === current ? child : undefined
  const groups = eligible?.capabilities
  const models = structuredAgentSessionOptionModels(
    inventory.models.length ? inventory.models : fallback,
    current,
    (row) => row
  ).map((row) => {
    if (row.id !== current) {
      return row
    }
    const seed = fallback.find((entry) => entry.id === current)
    const effort = groups?.effort
    return {
      ...row,
      ...(effort
        ? { efforts: effort.choices, defaultEffort: effort.default, effortsKnown: undefined }
        : row.effortsKnown === false && seed
          ? {
              efforts: seed.efforts,
              defaultEffort: seed.defaultEffort,
              effortsKnown: seed.effortsKnown
            }
          : {}),
      serviceTiers: groups?.tiers ?? row.serviceTiers ?? seed?.serviceTiers,
      supportsFastMode:
        restriction?.supported === false
          ? false
          : (groups?.fast ?? row.supportsFastMode ?? seed?.supportsFastMode)
    }
  })
  const support = models.find((row) => row.id === current)?.supportsFastMode
  return {
    models,
    fastModeSupport:
      restriction ??
      (support !== undefined
        ? { supported: support, ...(support ? {} : { reason: 'model-not-supported' }) }
        : inventory.fastModeSupport?.supported === false &&
            inventory.fastModeSupport.reason !== 'model-not-supported'
          ? inventory.fastModeSupport
          : undefined),
    listedServiceTiers: [
      ...inventory.models,
      ...models.filter((row) => row.id === current)
    ].flatMap((row) => row.serviceTiers?.map((tier) => tier.value) ?? [])
  }
}
