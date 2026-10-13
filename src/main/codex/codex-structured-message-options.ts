import type { AgentSessionExecutionOptions } from '../../shared/agent-session-execution-options'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { codexAcquireCatalogListing } from './codex-structured-catalog-entry'
import { CODEX_DEFAULT_SERVICE_TIER } from './codex-structured-service-tier'
import type { CodexSession } from './codex-structured-session-state'
import {
  applyCodexStructuredSessionOption,
  codexSessionCatalogListingForPicker
} from './codex-structured-session-options'

/** Validate one message without changing the saved pick for the next send. */
export async function resolvedCodexMessageOptions(
  session: CodexSession,
  choices: AgentSessionExecutionOptions | undefined
): Promise<Readonly<Record<string, string>> | undefined> {
  if (choices === undefined) {
    return undefined
  }
  let listing = codexAcquireCatalogListing(session.catalogAccess)
  if (choices.model === undefined || choices.effort === undefined) {
    try {
      listing = await codexSessionCatalogListingForPicker(session, 3_000)
    } catch (error) {
      throw new AgentSessionOptionRejectedError(error)
    }
  }
  const model = choices.model ?? listing?.models.find((entry) => entry.isDefault)?.id
  if (!model) {
    throw new AgentSessionOptionRejectedError(new Error('codex default model is unavailable'))
  }
  // Turn overrides persist in Codex, so every captured message starts from its own model defaults.
  const selected = {
    ...session,
    options: new Map<string, string>([
      ['personality', 'none'],
      ['serviceTier', CODEX_DEFAULT_SERVICE_TIER]
    ]),
    reportedOptions: { ...session.reportedOptions, effort: undefined }
  }
  await applyCodexStructuredSessionOption(selected, 'model', model)
  const defaultEffort = listing?.models.find((entry) => entry.id === model)?.defaultEffort
  if (choices.effort === undefined && defaultEffort && !selected.options.has('effort')) {
    await applyCodexStructuredSessionOption(selected, 'effort', defaultEffort)
  }
  for (const key of ['effort', 'personality', 'fastMode', 'serviceTier'] as const) {
    const value = choices[key]
    if (value !== undefined) {
      await applyCodexStructuredSessionOption(selected, key, value)
    }
  }
  const effort = selected.options.get('effort')
  const personality = selected.options.get('personality')
  const serviceTier = selected.options.get('serviceTier')
  return {
    model,
    ...(effort ? { effort } : {}),
    ...(personality ? { personality } : {}),
    ...(serviceTier ? { serviceTier } : {})
  }
}
