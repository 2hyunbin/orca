import type { SenderScopedRequestCancellations } from './sender-scoped-request-cancellation'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { ipcMain } from 'electron'
import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult,
  AiVaultSessionResumePreparation
} from '../../shared/ai-vault-resume-preparation'
import { isUnresolvedOwnerHostId, parseExecutionHostId } from '../../shared/execution-host'
import { isWslUncPath } from '../../shared/wsl-paths'
import { assertLegacyAiVaultResumeAllowed } from '../ai-vault/structured-session-ownership'
import { tryEnsureStructuredAgentSessionHostForResume } from '../runtime/structured-agent-session-host-refusal'

export type AiVaultResumeHandlerOptions = {
  selectedRequestCancellations?: SenderScopedRequestCancellations
  ensureStructuredSessionOwnership?: () => Promise<void>
  prepareSessionResume?: AiVaultSessionResumePreparation
  prepareRuntimeSessionResume?: (
    environmentId: string,
    args: AiVaultPrepareSessionResumeArgs,
    options?: { signal?: AbortSignal; expectedEnvironmentPairingRevision?: number }
  ) => Promise<AiVaultPrepareSessionResumeResult>
}

export function registerAiVaultResumeHandler(options: AiVaultResumeHandlerOptions): void {
  ipcMain.handle(
    'aiVault:prepareSessionResume',
    async (event, args: AiVaultPrepareSessionResumeArgs) => {
      const token = args.requestContext?.requestToken
      const controller =
        typeof token === 'string' && token.length <= 128
          ? (options.selectedRequestCancellations?.begin(event, token) ?? null)
          : null
      try {
        return await waitForPromiseWithSignal(
          prepareAiVaultSessionResume(args, options, controller?.signal),
          controller?.signal
        )
      } finally {
        options.selectedRequestCancellations?.finish(event, token, controller)
      }
    }
  )
}

export async function prepareAiVaultSessionResume(
  args: AiVaultPrepareSessionResumeArgs,
  options: AiVaultResumeHandlerOptions,
  signal?: AbortSignal
): Promise<AiVaultPrepareSessionResumeResult> {
  const { requestContext, ...request } = args
  signal?.throwIfAborted()
  const executionHost = parseExecutionHostId(args.executionHostId)
  if (executionHost?.kind === 'runtime') {
    if (!options.prepareRuntimeSessionResume || isUnresolvedOwnerHostId(executionHost.id)) {
      throw new Error('The session host is unavailable. Reconnect it and retry resume.')
    }
    return requestContext || signal
      ? options.prepareRuntimeSessionResume(executionHost.environmentId, request, {
          signal,
          expectedEnvironmentPairingRevision: requestContext?.expectedEnvironmentPairingRevision
        })
      : options.prepareRuntimeSessionResume(executionHost.environmentId, request)
  }
  // Why: the desktop process must never materialize transcript paths owned by an SSH host.
  if (executionHost?.kind === 'ssh') {
    return { useRealCodexHome: false }
  }
  if (!isWslUncPath(args.filePath)) {
    if (options.ensureStructuredSessionOwnership) {
      await (args.codexHome === null && !args.fork
        ? tryEnsureStructuredAgentSessionHostForResume(options.ensureStructuredSessionOwnership)
        : options.ensureStructuredSessionOwnership())
    }
    signal?.throwIfAborted()
    assertLegacyAiVaultResumeAllowed(request)
  }
  signal?.throwIfAborted()
  return options.prepareSessionResume?.(request) ?? { useRealCodexHome: false }
}
