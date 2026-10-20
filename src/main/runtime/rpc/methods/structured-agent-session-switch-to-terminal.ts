// `agentSession.switchToTerminal` — the chat's half of moving its conversation into a terminal on
// the same id. In the chat's ordered step it refuses unless idle, registers the switch's claim,
// stops the agent with proven exit while the tab stays, and answers the facts a terminal resume
// needs. The claim refuses a chat start from any view until the terminal it names can be judged.
// Gated per agent by `agent-session.structured.switch.v1:<agent>`; a client never falls back to close.

import { inPlaceSwitchEnabled } from '../../../../shared/structured-agent-cli-conversation-adoption'
import type { AiVaultChatForkSource } from '../../../../shared/ai-vault-resume-preparation'
import {
  prepareStructuredChatCliTranscript,
  resolveStructuredChatCliSource
} from '../../../ai-vault/structured-chat-cli-fork'
import type { SwitchClaim } from '../../session-tabs/structured-session-switch-claims'
import { defineMethod } from '../core'
import {
  ensureStructuredHostInstalled,
  requireStructuredCapability,
  requireStructuredSessionHost
} from './structured-agent-session-gate'
import { OptionsParams } from './structured-agent-session-schemas'

export const STRUCTURED_AGENT_SESSION_SWITCH_TO_TERMINAL_METHODS = [
  defineMethod({
    name: 'agentSession.switchToTerminal',
    permission: 'workspace',
    params: OptionsParams,
    handler: async (params, ctx): Promise<{ source: AiVaultChatForkSource }> => {
      requireStructuredCapability(ctx)
      await ensureStructuredHostInstalled(ctx)
      const host = requireStructuredSessionHost(ctx, params.sessionId)
      const record = host.deps.store.getRecord(params.sessionId)
      if (!record || !inPlaceSwitchEnabled(record.provider)) {
        throw new Error('This chat cannot switch to a terminal on this host.')
      }
      // Reads only: a chat that can't be resumed in a terminal is refused before anything stops.
      const source = await resolveStructuredChatCliSource(
        { sessionId: record.sessionId, workspaceId: record.location.workspaceId },
        false
      )
      // A switch terminal whose agent provably ended no longer holds the conversation.
      await ctx.runtime.releaseEndedSwitchStarts(source.agent, source.providerSessionId)
      let claim: SwitchClaim | undefined
      try {
        await host.switchToTerminal(params.sessionId, () => {
          claim = ctx.runtime.registerSwitchClaim(source.agent, source.providerSessionId)
        })
        const prepared = await prepareStructuredChatCliTranscript(
          source,
          (args) => ctx.runtime.prepareAiVaultSessionResume(args),
          false
        )
        if (!prepared.cliForkSource) {
          throw new Error('This chat has no saved conversation available on this host.')
        }
        return { source: prepared.cliForkSource }
      } catch (error) {
        // No recipe left this host, so nothing can start under the claim.
        if (claim) {
          ctx.runtime.dropSwitchClaim(claim)
        }
        throw error
      }
    }
  })
]
