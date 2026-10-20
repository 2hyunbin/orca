// `agentSession.switchToTerminal` — the chat's half of moving its conversation into a terminal on
// the same id. Before any stop it checks the route can hold the start and prepares the recipe; then,
// in the chat's ordered step, it refuses unless idle, registers one switch generation and stops the
// agent with proven exit. Only that generation's terminal owner can later end the switch.
// Gated per agent by `agent-session.structured.switch.v1:<agent>`; a client never falls back to close.

import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
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
    handler: async (
      params,
      ctx
    ): Promise<{ source: AiVaultChatForkSource; generation: string }> => {
      requireStructuredCapability(ctx)
      await ensureStructuredHostInstalled(ctx)
      const host = requireStructuredSessionHost(ctx, params.sessionId)
      const record = host.deps.store.getRecord(params.sessionId)
      if (!record || !inPlaceSwitchEnabled(record.provider)) {
        throw new Error('This chat cannot switch to a terminal on this host.')
      }
      // Before anything stops: the source, a route that can hold the start, and its recipe.
      const source = await resolveStructuredChatCliSource(
        { sessionId: record.sessionId, workspaceId: record.location.workspaceId },
        false
      )
      const owner = await ctx.runtime.terminalSwitchOwner()
      if (!owner) {
        throw agentSessionRefusalError('structured_agent_session_unsupported', {
          reason: 'hostUnsupported'
        })
      }
      const prepared = await prepareStructuredChatCliTranscript(
        source,
        (args) => ctx.runtime.prepareAiVaultSessionResume(args),
        false
      )
      if (!prepared.cliForkSource) {
        throw new Error('This chat has no saved conversation available on this host.')
      }
      // A switch whose owner proved its start over no longer holds the conversation.
      await ctx.runtime.releaseEndedSwitchStarts(source.agent, source.providerSessionId)
      let claim: SwitchClaim | undefined
      try {
        await host.switchToTerminal(params.sessionId, () => {
          claim = ctx.runtime.registerSwitchClaim(
            source.agent,
            source.providerSessionId,
            record.sessionId,
            owner
          )
        })
        if (!claim) {
          throw new Error('This chat could not switch to a terminal.')
        }
        return { source: prepared.cliForkSource, generation: claim.generation }
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
