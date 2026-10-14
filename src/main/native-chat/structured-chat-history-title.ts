import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import type { AiVaultAgent } from '../../shared/ai-vault-types'
import {
  isAiVaultTitleAgent,
  type AiVaultSessionTitleRequest,
  type AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'
import { generatedSessionTitle } from '../ai-vault/session-scanner-accumulator'
import type { StructuredAgentSessionStatusObserverOptions } from './agent-session-wire/structured-agent-session-status-observation'

/** The conversation's own title as Session History lists it; null when History has only its
 *  "<Agent> <id prefix>" placeholder, which names nothing. */
export function structuredChatHistoryTitle(
  agent: AiVaultAgent,
  providerSessionId: string,
  title: string
): string | null {
  const trimmed = title.trim()
  return trimmed && trimmed !== generatedSessionTitle(agent, providerSessionId) ? trimmed : null
}

type ChatConversation = {
  sessionId: string
  workspaceId: string
  agent: string
  providerSession?: AgentProviderSessionMetadata
}

export type StructuredChatHistoryTitles = ReturnType<typeof createStructuredChatHistoryTitles>

/**
 * A Claude or Codex chat's fallback name: its conversation's Session History title, the same title
 * a terminal running that conversation falls back to. Held in memory only, since History derives it.
 */
export function createStructuredChatHistoryTitles(deps: {
  resolveTitles: (requests: AiVaultSessionTitleRequest[]) => Promise<AiVaultSessionTitlesResult>
  onChanged: (workspaceId: string, sessionId: string) => void
}) {
  const titles = new Map<string, string>()
  const looked = new Set<string>()
  const inFlight = new Set<string>()
  // A turn that ends mid-lookup reruns it, so the newer title is never dropped.
  const rerun = new Set<string>()
  const lastStatus = new Map<string, AgentSessionStatusSummary['status']>()

  const refresh = (chat: ChatConversation): void => {
    const providerSessionId = chat.providerSession?.id
    if (!providerSessionId || !isAiVaultTitleAgent(chat.agent)) {
      return
    }
    if (inFlight.has(chat.sessionId)) {
      rerun.add(chat.sessionId)
      return
    }
    const agent = chat.agent
    looked.add(chat.sessionId)
    inFlight.add(chat.sessionId)
    void deps
      .resolveTitles([{ agent, sessionId: providerSessionId }])
      .then((result) => {
        const found = result.titles.find((entry) => entry.sessionId === providerSessionId)
        const title = found
          ? structuredChatHistoryTitle(agent, providerSessionId, found.title)
          : null
        if (title && titles.get(chat.sessionId) !== title) {
          titles.set(chat.sessionId, title)
          deps.onChanged(chat.workspaceId, chat.sessionId)
        }
      })
      // A name is cosmetic: a failed lookup keeps the chat's default label.
      .catch(() => {})
      .finally(() => {
        inFlight.delete(chat.sessionId)
        if (rerun.delete(chat.sessionId)) {
          refresh(chat)
        }
      })
  }

  return {
    /** The cached title; the first ask starts the lookup, as a chat reopened after a restart has
     *  no finished turn in this process to start one. */
    titleFor(chat: ChatConversation): string | undefined {
      if (!looked.has(chat.sessionId)) {
        refresh(chat)
      }
      return titles.get(chat.sessionId)
    },
    /** A finished turn is when the title can change: the first prompt lands, or the agent renames. */
    observe(
      summary: AgentSessionStatusSummary,
      options: StructuredAgentSessionStatusObserverOptions
    ): void {
      const previous = lastStatus.get(summary.sessionId)
      lastStatus.set(summary.sessionId, summary.status)
      if (!options.replay && summary.status === 'idle' && previous && previous !== 'idle') {
        refresh(summary)
      }
    }
  }
}
