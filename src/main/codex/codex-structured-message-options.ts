import type { AgentSessionExecutionOptions } from '../../shared/agent-session-execution-options'
import type { CodexSession } from './codex-structured-session-state'
import { codexSessionCapabilities } from './codex-structured-catalog-entry'
import { codexServiceTierOfFastMode } from './codex-structured-session-options'
import { codexTurnRequestOptions } from './codex-structured-service-tier'

/** Captured fields are overrides; omitted fields inherit the native thread's state. */
export async function resolvedCodexMessageOptions(
  session: CodexSession,
  choices: AgentSessionExecutionOptions | undefined
): Promise<Readonly<Record<string, string>> | undefined> {
  if (choices === undefined) {
    return undefined
  }
  const compiled: Record<string, string> = {}
  for (const key of ['model', 'effort', 'personality', 'serviceTier'] as const) {
    const value = choices[key]
    if (value !== undefined) {
      compiled[key] = value
    }
  }
  if (choices.serviceTier === undefined && choices.fastMode !== undefined) {
    const model = codexSessionCapabilities(session).models.find(
      (row) => row.id === (choices.model ?? session.reportedOptions.model)
    )
    compiled.serviceTier = codexServiceTierOfFastMode(choices.fastMode, model)
  }
  return codexTurnRequestOptions(session, compiled)
}
