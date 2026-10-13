import { selectedSessionFromLegacyList } from '../../shared/ai-vault-selected-session-legacy'
import { ipcMain } from 'electron'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type {
  AiVaultResolveSessionArgs,
  AiVaultResolveSessionResult
} from '../../shared/ai-vault-selected-session'
import {
  AI_VAULT_SELECTED_SESSION_CAPABILITY,
  LEGACY_SELECTED_SESSION_LOOKUP_TIMEOUT_MS,
  SELECTED_SESSION_LOOKUP_TIMEOUT_MS
} from '../../shared/ai-vault-selected-session'
import {
  SelectedSessionResultSchema,
  SelectedSessionSourceSchema
} from '../../shared/ai-vault-selected-session-contract'
import { LOCAL_EXECUTION_HOST_ID, parseRoutableExecutionHostId } from '../../shared/execution-host'
import { createSenderScopedRequestCancellations } from './sender-scoped-request-cancellation'
import {
  callRuntimeEnvironment,
  getRuntimeEnvironmentStatus
} from './runtime-environment-transport-routing'
import { withSelectedSessionDeadline } from '../ai-vault/selected-session-deadline'
import { parseAiVaultListResult } from '../ai-vault/session-list-result-validation'

export async function resolveSelectedSessionByHost(
  args: AiVaultResolveSessionArgs,
  local: OrcaRuntimeService['resolveAiVaultSelectedSession'],
  userDataPath: string,
  signal?: AbortSignal
): Promise<AiVaultResolveSessionResult> {
  const started = Date.now()
  const source = SelectedSessionSourceSchema.parse(args.source)
  if (args.executionHostId === LOCAL_EXECUTION_HOST_ID) {
    return local(source, signal)
  }
  const host = parseRoutableExecutionHostId(args.executionHostId)
  if (host?.kind !== 'runtime' || source.kind !== 'chat') {
    throw new Error('The conversation host is unavailable.')
  }
  const status = await withSelectedSessionDeadline(
    (owned) =>
      getRuntimeEnvironmentStatus(userDataPath, host.environmentId, 15_000, { signal: owned }),
    signal
  )
  if (!status.ok) {
    throw new Error(status.error.message)
  }
  const modern = status.result.capabilities?.includes(AI_VAULT_SELECTED_SESSION_CAPABILITY) === true
  const timeout = modern
    ? SELECTED_SESSION_LOOKUP_TIMEOUT_MS
    : LEGACY_SELECTED_SESSION_LOOKUP_TIMEOUT_MS
  return withSelectedSessionDeadline(
    async (owned) => {
      const response = await callRuntimeEnvironment(
        userDataPath,
        host.environmentId,
        modern ? 'aiVault.resolveSession' : 'aiVault.listSessions',
        modern
          ? { source, executionHostId: host.id }
          : {
              limit: args.legacyList?.limit,
              unlimited: args.legacyList?.unlimited,
              includeAntigravityIdeSessions: args.legacyList?.includeAntigravityIdeSessions,
              scopePaths: args.legacyList?.scopePaths,
              executionHostId: host.id
            },
        timeout,
        undefined,
        undefined,
        { signal: owned }
      )
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      if (modern) {
        const resolved = SelectedSessionResultSchema.parse(response.result)
        return resolved.status === 'ready'
          ? { ...resolved, session: { ...resolved.session, executionHostId: host.id } }
          : resolved
      }
      return selectedSessionFromLegacyList(parseAiVaultListResult(response.result), source, host.id)
    },
    signal,
    Math.max(1, timeout - (Date.now() - started))
  )
}

export function registerAiVaultSelectedSessionHandlers(
  runtime: OrcaRuntimeService,
  userDataPath: string
): void {
  const cancellations = createSenderScopedRequestCancellations()
  ipcMain.handle('aiVault:resolveSession', async (event, args: AiVaultResolveSessionArgs) => {
    const token =
      typeof args.requestToken === 'string' && args.requestToken.length <= 128
        ? args.requestToken
        : undefined
    const controller = cancellations.begin(event, token)
    try {
      return await resolveSelectedSessionByHost(
        args,
        runtime.resolveAiVaultSelectedSession.bind(runtime),
        userDataPath,
        controller?.signal
      )
    } catch (error) {
      if (controller?.signal.aborted) {
        return { status: 'cancelled' }
      }
      throw error
    } finally {
      cancellations.finish(event, token, controller)
    }
  })
  ipcMain.handle('aiVault:cancelResolveSession', (event, args: { requestToken: string }) => {
    if (typeof args?.requestToken === 'string') {
      cancellations.cancel(event, args.requestToken)
    }
  })
}
