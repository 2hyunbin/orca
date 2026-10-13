import type { AgentSessionExecutionOptions } from '../../shared/agent-session-execution-options'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { listedModels } from './claude-structured-model-catalog'
import { setClaudeStructuredOption } from './claude-structured-options'
import { readClaudeCurrentModel } from './claude-structured-session-options'
import type { ClaudeSession } from './claude-structured-session-state'

/** Applies the accepted message's choices while its prompt is still in the SDK input queue. */
export async function applyClaudeMessageOptions(
  session: ClaudeSession,
  options: AgentSessionExecutionOptions,
  timeoutMs: number | undefined
): Promise<void> {
  const model = options.model ?? (await defaultModelForMessage(session, timeoutMs))
  if (model && readClaudeCurrentModel(session).id !== model) {
    await setClaudeStructuredOption(session, { key: 'model', value: model }, timeoutMs)
  }

  const effort = options.effort ?? session.configuredDefaults?.effort
  if (
    effort &&
    (session.options.get('effort') !== effort || !session.confirmedOptions.has('effort'))
  ) {
    await setClaudeStructuredOption(session, { key: 'effort', value: effort }, timeoutMs)
    if (
      effort !== 'max' &&
      !session.confirmedOptions.has('effort') &&
      session.reportedOptions.effort !== undefined &&
      session.reportedOptions.effort !== effort
    ) {
      throw new AgentSessionOptionRejectedError(
        `Claude reported effort ${session.reportedOptions.effort} instead of ${effort}`
      )
    }
  } else if (!effort && session.options.has('effort')) {
    throw new AgentSessionOptionRejectedError('Claude did not report its configured effort')
  }

  const fastMode = options.fastMode ?? 'false'
  if (
    session.options.get('fastMode') !== fastMode &&
    (options.fastMode || session.options.has('fastMode'))
  ) {
    await setClaudeStructuredOption(session, { key: 'fastMode', value: fastMode }, timeoutMs)
    if (session.options.get('fastMode') !== fastMode) {
      throw new AgentSessionOptionRejectedError(`Claude did not apply Fast mode ${fastMode}`)
    }
  }
}

async function defaultModelForMessage(
  session: ClaudeSession,
  timeoutMs: number | undefined
): Promise<string | undefined> {
  if (session.configuredDefaults?.model) {
    return session.configuredDefaults.model
  }
  if (!session.options.has('model')) {
    return undefined
  }
  const response = await session.connection.supportedModels({ timeoutMs }).catch(() => null)
  const listed = listedModels(response ? { models: response } : null)
  const fallback = listed.find((model) => model.isDefault)?.id
  if (!fallback) {
    throw new AgentSessionOptionRejectedError('Claude did not report its default model')
  }
  return fallback
}
