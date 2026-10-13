import type { AgentSessionExecutionOptions } from '../../shared/agent-session-execution-options'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { codexAcquireCatalogListing } from './codex-structured-catalog-entry'
import { CODEX_DEFAULT_SERVICE_TIER } from './codex-structured-service-tier'
import type { CodexSession } from './codex-structured-session-state'
import { applyCodexStructuredSessionOption } from './codex-structured-session-options'

/** Validate one message against known facts without reading the provider or changing the next pick. */
export async function resolvedCodexMessageOptions(
  session: CodexSession,
  choices: AgentSessionExecutionOptions | undefined
): Promise<Readonly<Record<string, string>> | undefined> {
  if (choices === undefined) {
    return undefined
  }
  const listing = codexAcquireCatalogListing(session.catalogAccess)
  const listedDefault = listing?.models.find((entry) => entry.isDefault)
  const priorModel = session.options.get('model')
  const priorEffort = session.options.get('effort')
  const model =
    choices.model ??
    listedDefault?.id ??
    session.nativeDefaults?.model ??
    (priorModel || priorEffort ? undefined : session.reportedOptions.model)
  if (!model && (choices.effort || priorModel || priorEffort)) {
    throw new AgentSessionOptionRejectedError(new Error('codex default model is unavailable'))
  }
  const listedModel = listing?.models.find((entry) => entry.id === model)
  const defaultEffort =
    listedModel?.defaultEffort ??
    (model === session.nativeDefaults?.model ? session.nativeDefaults?.effort : undefined)
  if (choices.effort === undefined && priorEffort && !defaultEffort) {
    throw new AgentSessionOptionRejectedError(new Error('codex default effort is unavailable'))
  }
  // Codex retains turn overrides, so defaults must be named after an earlier override.
  const selected = {
    ...session,
    options: new Map<string, string>([
      ['personality', 'none'],
      ['serviceTier', CODEX_DEFAULT_SERVICE_TIER]
    ]),
    reportedOptions: { ...session.reportedOptions, effort: undefined }
  }
  if (
    model &&
    (choices.model ||
      priorModel ||
      priorEffort ||
      choices.effort ||
      choices.fastMode === 'true' ||
      (choices.serviceTier && choices.serviceTier !== CODEX_DEFAULT_SERVICE_TIER))
  ) {
    await applyCodexStructuredSessionOption(selected, 'model', model)
    if (!defaultEffort && choices.effort === undefined) {
      selected.options.delete('effort')
    }
  }
  if (choices.effort === undefined && defaultEffort && (priorEffort || choices.model)) {
    await applyCodexStructuredSessionOption(selected, 'effort', defaultEffort)
  }
  for (const key of ['effort', 'personality', 'fastMode', 'serviceTier'] as const) {
    const value = choices[key]
    if (value !== undefined) {
      await applyCodexStructuredSessionOption(selected, key, value)
    }
  }
  return Object.fromEntries(selected.options)
}
