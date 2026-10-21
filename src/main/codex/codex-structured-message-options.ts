import { savedEffectiveServiceTier } from '../../shared/structured-agent-session-effective-tier'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { codexFastServiceTier } from './codex-structured-service-tier'
import type { AgentSessionExecutionOptions } from '../../shared/agent-session-execution-options'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { readCodexConfiguredLaunchDefaults } from './codex-configured-launch-defaults'
import { codexAcquireCatalogListing } from './codex-structured-catalog-entry'
import { CODEX_DEFAULT_SERVICE_TIER } from './codex-structured-service-tier'
import type { CodexSession } from './codex-structured-session-state'
import { applyCodexStructuredSessionOption } from './codex-structured-session-options'

/** Resolve one message's choices and baseline without changing the next pick. */
export async function resolvedCodexMessageOptions(
  session: CodexSession,
  choices: AgentSessionExecutionOptions | undefined
): Promise<Readonly<Record<string, string>> | undefined> {
  if (choices === undefined) {
    return undefined
  }
  const listing = codexAcquireCatalogListing(session.catalogAccess)
  const priorModel = session.options.get('model')
  const priorEffort = session.options.get('effort')
  // An unchosen key keeps what the thread runs; another model brings its own default effort.
  const thread = session.reportedOptions
  const model =
    choices.model ?? thread.model ?? listing?.models.find((entry) => entry.isDefault)?.id
  if (!model && (choices.effort || priorModel || priorEffort)) {
    throw new AgentSessionOptionRejectedError(new Error('codex default model is unavailable'))
  }
  const listedModel = listing?.models.find((entry) => entry.id === model)
  const threadEffort = model === thread.model ? thread.effort : undefined
  const defaultEffort =
    threadEffort &&
    (!listedModel || listedModel.efforts.some((entry) => entry.value === threadEffort))
      ? threadEffort
      : listedModel?.defaultEffort
  if (choices.effort === undefined && priorEffort && !defaultEffort) {
    throw new AgentSessionOptionRejectedError(new Error('codex default effort is unavailable'))
  }
  // Capture the configured baseline before overrides, independently of provider reports.
  if (!session.nativeDefaults) {
    const configured = await readCodexConfiguredLaunchDefaults(session.connection)
    session.nativeDefaults = {
      ...(configured?.personality ? { personality: configured.personality } : {}),
      serviceTier: configured?.serviceTier ?? CODEX_DEFAULT_SERVICE_TIER
    }
  }
  const restored: Record<string, string> = {}
  for (const key of ['personality', 'serviceTier'] as const) {
    const applied = session.appliedTurnOptions?.[key]
    if (
      choices[key] !== undefined ||
      (key === 'serviceTier' && choices.fastMode !== undefined) ||
      !applied
    ) {
      continue
    }
    const baseline = session.nativeDefaults?.[key]
    if (!baseline) {
      throw new AgentSessionOptionRejectedError(new Error(`codex default ${key} is unavailable`))
    }
    if (applied !== baseline) {
      restored[key] = baseline
    }
  }
  const selected = {
    ...session,
    options: new Map<string, string>(Object.entries(restored)),
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
    // Captured message input is already accepted; the provider judges the literal model.
    selected.options.set('model', model)
    if (!defaultEffort && choices.effort === undefined) {
      selected.options.delete('effort')
    }
    // Where the model brought an effort, it is the thread's own for the thread's model.
    if (
      choices.effort === undefined &&
      defaultEffort &&
      (priorEffort || choices.model || selected.options.has('effort'))
    ) {
      await applyCodexStructuredSessionOption(selected, 'effort', defaultEffort)
    }
  }
  for (const key of ['effort', 'personality', 'fastMode', 'serviceTier'] as const) {
    const value = choices[key]
    if (value !== undefined) {
      await applyCodexStructuredSessionOption(selected, key, value)
    }
  }
  return Object.fromEntries(selected.options)
}

/** Compare applied inputs under the child that received them, independently of observations. */
export function readCodexAppliedInputOptions(
  session: CodexSession | undefined,
  input: Parameters<NonNullable<StructuredAgentSessionAdapter['readAppliedInputOptions']>>[0]
): ReturnType<NonNullable<StructuredAgentSessionAdapter['readAppliedInputOptions']>> {
  if (
    !session ||
    session.ended ||
    session.fence !== input.fence ||
    session.acquisitionGeneration !== input.acquisitionGeneration ||
    !session.appliedTurnOptions
  ) {
    return null
  }
  const baseline = session.nativeDefaults?.serviceTier
  const active = {
    ...session.appliedTurnOptions,
    serviceTier: session.appliedTurnOptions.serviceTier ?? baseline
  }
  const requested = input.next ?? {}
  const models = codexAcquireCatalogListing(session.catalogAccess)?.models ?? []
  const model = models.find((entry) => entry.id === (requested.model ?? active.model))
  const tier =
    requested.serviceTier ??
    (requested.fastMode === 'true'
      ? (codexFastServiceTier(model) ?? baseline)
      : requested.fastMode === 'false'
        ? 'default'
        : baseline)
  const serviceTier = savedEffectiveServiceTier(
    { model: requested.model ?? active.model, serviceTier: tier },
    models
  )
  return { active, next: { ...requested, ...(serviceTier ? { serviceTier } : {}) } }
}
