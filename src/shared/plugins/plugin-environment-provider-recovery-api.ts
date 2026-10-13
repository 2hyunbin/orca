import { z } from 'zod'
import { pluginEnvironmentProviderReviewSchema } from './plugin-environment-provider-api'
import type { EnvironmentRecipeRecoveryResponse } from '../environment-recipe-recovery-protocol'
import type { EnvironmentCommandExecutionResult } from './plugin-environment-recipe-result'
import type { EnvironmentRecipeJournalOperation } from './plugin-environment-recipe-journal'

export const pluginEnvironmentProviderRecoverSchema = z.strictObject({
  review: pluginEnvironmentProviderReviewSchema,
  queryId: z.uuid(),
  originalOperationId: z.uuid()
})
export type PluginEnvironmentProviderRecoverRequest = z.infer<
  typeof pluginEnvironmentProviderRecoverSchema
>
export type PluginEnvironmentProviderRecoveryResult =
  | { kind: 'known'; operation: EnvironmentRecipeJournalOperation }
  | {
      kind: 'inspected'
      operation: EnvironmentRecipeJournalOperation
      result: EnvironmentCommandExecutionResult<EnvironmentRecipeRecoveryResponse>
    }
