import type { EnvironmentRecipeResponse } from '../environment-recipe-protocol'
import type { EnvironmentRecipeJournalOperation } from './plugin-environment-recipe-journal'

export type EnvironmentCommandUnverifiableReason =
  | 'cancelled'
  | 'timeout'
  | 'output-limit'
  | 'command-failed'
  | 'invalid-response'
  | 'authority-changed'
  | 'provider-unavailable'
export type EnvironmentCommandExecutionResult<T> =
  | { kind: 'completed'; response: T }
  | { kind: 'refused'; reason: 'approval-required' | 'unsupported-action' | 'cancelled' }
  | {
      kind: 'unverifiable'
      reason: EnvironmentCommandUnverifiableReason
    }

export type EnvironmentRecipeExecutionResult =
  EnvironmentCommandExecutionResult<EnvironmentRecipeResponse>

export type JournaledEnvironmentRecipeResult =
  | { kind: 'recorded'; operation: EnvironmentRecipeJournalOperation }
  | {
      kind: 'executed'
      operation: EnvironmentRecipeJournalOperation
      result: EnvironmentRecipeExecutionResult
    }
