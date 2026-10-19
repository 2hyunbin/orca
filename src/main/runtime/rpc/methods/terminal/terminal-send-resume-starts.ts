import { assertLegacyAiVaultResumeCommandAllowed } from '../../../../ai-vault/structured-session-ownership'
import { terminalConversationKey } from '../../../../native-chat/structured-conversation-key'
import type { TerminalSend } from '../../../../../shared/rpc-contract/terminal-unary-params'
import type { ManagedConversationStart } from '../../../managed-conversation-starts'
import type { RpcContext, RpcTypedMethod } from '../../core'
import { assertTerminalSendTextWithinLimit } from './terminal-input-delivery'

/** A send whose text resumes a conversation refuses one a chat holds; otherwise it registers the
 *  start in the same step, bound to the PTY it writes, and drops it when nothing was written. */
export function withTerminalSendResumeStarts<TName extends string, TResult>(
  method: RpcTypedMethod<TName, typeof TerminalSend, Promise<TResult>>
): RpcTypedMethod<TName, typeof TerminalSend, Promise<TResult>> {
  const send = method.handler
  return {
    ...method,
    handler: async (params, context) => {
      const { runtime } = context
      await assertTerminalSendTextWithinLimit(params.text)
      await assertTerminalSendTextWithinLimit(params.resolvedLaunchDraft?.text)
      const starts: ManagedConversationStart[] = []
      try {
        for (const text of [params.text, params.resolvedLaunchDraft?.text]) {
          const start = text
            ? await assertLegacyAiVaultResumeCommandAllowed(
                text,
                () => runtime.ensureStructuredAgentSessionHost(),
                (invocations) =>
                  runtime.reserveManagedConversationStart(
                    invocations.map((invocation) =>
                      terminalConversationKey(invocation.provider, invocation.target)
                    ),
                    livePtyId(context, params.terminal)
                  )
              )
            : undefined
          if (start) {
            starts.push(start)
          }
        }
        const result = await send(params, context)
        if (!sendAccepted(result)) {
          starts.forEach((start) => start.drop())
        }
        return result
      } catch (error) {
        starts.forEach((start) => start.drop())
        throw error
      }
    }
  }
}

// The send itself reports a stale handle; here it only means nothing to bind.
function livePtyId({ runtime }: RpcContext, handle: string): string | null {
  try {
    return runtime.resolveLiveLeafForHandle(handle)?.ptyId ?? null
  } catch {
    return null
  }
}

function sendAccepted(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    'send' in result &&
    typeof result.send === 'object' &&
    result.send !== null &&
    'accepted' in result.send &&
    result.send.accepted === true
  )
}
