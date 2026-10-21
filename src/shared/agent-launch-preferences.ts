import type { AgentLaunchPreferences } from './agent-session-host-authority'
import type { AgentType } from './agent-status-types'
import { readLaunchPermissionMode } from './agent-permission-mode-terminal-args'
import { findCatalogModel, getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import { decodeCatalogOptionValue } from './structured-agent-session-option-codec'

/** Session options as the model, effort and mode a launch starts with; one converter for every lane,
 *  so a structured create and a terminal launch read the same picks the same way. A saved permission
 *  mode rides `mode`; hosts without the terminal permission table ignore it. */
export function toAgentLaunchPreferences(
  sessionOptions: Readonly<Record<string, unknown>> | null | undefined,
  agent?: AgentType
): AgentLaunchPreferences | undefined {
  if (!sessionOptions) {
    return undefined
  }
  const readString = (key: keyof AgentLaunchPreferences): string | undefined => {
    const value = sessionOptions[key]
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  }
  const model = agent ? composedLaunchModel(agent, sessionOptions) : readString('model')
  const effort = readString('effort')
  const mode = readString('mode') ?? readLaunchPermissionMode(sessionOptions)
  const preferences: AgentLaunchPreferences = {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(mode ? { mode } : {})
  }
  return Object.keys(preferences).length > 0 ? preferences : undefined
}

// Why: options composed into the model id (Cursor) have no key of their own on the wire.
function composedLaunchModel(
  agent: AgentType,
  sessionOptions: Readonly<Record<string, unknown>>
): string | undefined {
  const model = typeof sessionOptions.model === 'string' ? sessionOptions.model.trim() : ''
  const catalog = getAgentSessionOptionCatalog(agent)
  if (!model || !catalog?.composeModelValue) {
    return model || undefined
  }
  const options = findCatalogModel(catalog, model)?.options ?? []
  const values = Object.fromEntries(
    options.flatMap((option) => {
      const raw = sessionOptions[option.id]
      const value =
        typeof raw === 'string' || typeof raw === 'boolean'
          ? decodeCatalogOptionValue(option.kind, raw)
          : undefined
      return value === undefined ? [] : [[option.id, value]]
    })
  )
  return options.length > 0 ? catalog.composeModelValue(model, values) : model
}
