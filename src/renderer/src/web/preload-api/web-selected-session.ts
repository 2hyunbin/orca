import type {
  AiVaultResolveSessionArgs,
  AiVaultResolveSessionResult
} from '../../../../shared/ai-vault-selected-session'
import {
  AI_VAULT_SELECTED_SESSION_CAPABILITY,
  SELECTED_SESSION_LOOKUP_TIMEOUT_MS,
  LEGACY_SELECTED_SESSION_LOOKUP_TIMEOUT_MS
} from '../../../../shared/ai-vault-selected-session'
import { SelectedSessionResultSchema } from '../../../../shared/ai-vault-selected-session-contract'
import { selectedSessionFromLegacyList } from '../../../../shared/ai-vault-selected-session-legacy'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import type { AiVaultListResult } from '../../../../shared/ai-vault-types'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { callRuntimeResult } from './web-runtime-calls'
import { requireActiveEnvironment } from './web-runtime-session'

const requests = new Map<string, AbortController>()
export async function resolveWebSelectedSession(
  args: AiVaultResolveSessionArgs
): Promise<AiVaultResolveSessionResult> {
  const environment = requireActiveEnvironment()
  const hostId = toRuntimeExecutionHostId(environment.id)
  if (args.executionHostId !== hostId) {
    throw new Error('The conversation host is unavailable.')
  }
  const controller = new AbortController()
  requests.set(args.requestToken, controller)
  const callOptions = {
    environmentId: environment.id,
    expectedEnvironmentPairingRevision: environment.pairingRevision ?? environment.createdAt,
    signal: controller.signal
  }
  const started = Date.now()
  let timer = setTimeout(
    () => controller.abort(new Error('Conversation lookup timed out.')),
    SELECTED_SESSION_LOOKUP_TIMEOUT_MS
  )
  try {
    const status = await callRuntimeResult<RuntimeStatus>(
      'status.get',
      undefined,
      SELECTED_SESSION_LOOKUP_TIMEOUT_MS,
      callOptions
    )
    const modern = status.capabilities?.includes(AI_VAULT_SELECTED_SESSION_CAPABILITY) === true
    if (!modern) {
      clearTimeout(timer)
      timer = setTimeout(
        () => controller.abort(new Error('Conversation lookup timed out.')),
        Math.max(1, LEGACY_SELECTED_SESSION_LOOKUP_TIMEOUT_MS - (Date.now() - started))
      )
      const listed = await callRuntimeResult<AiVaultListResult>(
        'aiVault.listSessions',
        { ...args.legacyList, executionHostId: hostId },
        LEGACY_SELECTED_SESSION_LOOKUP_TIMEOUT_MS,
        callOptions
      )
      return selectedSessionFromLegacyList(listed, args.source, hostId)
    }
    const result = await callRuntimeResult(
      'aiVault.resolveSession',
      { source: args.source, executionHostId: hostId },
      SELECTED_SESSION_LOOKUP_TIMEOUT_MS,
      callOptions
    )
    return SelectedSessionResultSchema.parse(result)
  } finally {
    clearTimeout(timer)
    if (requests.get(args.requestToken) === controller) {
      requests.delete(args.requestToken)
    }
  }
}
export function cancelWebSelectedSession(args: { requestToken: string }): Promise<void> {
  requests.get(args.requestToken)?.abort()
  return Promise.resolve()
}
