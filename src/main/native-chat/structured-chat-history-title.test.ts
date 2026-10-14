import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import { createStructuredChatHistoryTitles } from './structured-chat-history-title'

const chat = {
  sessionId: 'chat-1',
  workspaceId: 'workspace-1',
  agent: 'codex',
  providerSession: { key: 'session_id' as const, id: '01a13bcc-7852-7033-b035-426c73682bf9' }
}

function summary(status: AgentSessionStatusSummary['status']): AgentSessionStatusSummary {
  return { ...chat, status, latestPrompt: '', updatedAt: 1 }
}

describe('createStructuredChatHistoryTitles', () => {
  it("names a reopened chat after its conversation and follows the agent's later title", async () => {
    let historyTitle = 'Codex 01a13bcc'
    const resolveTitles = vi.fn(async () => ({
      titles: [{ agent: 'codex' as const, sessionId: chat.providerSession.id, title: historyTitle }]
    }))
    const onChanged = vi.fn()
    const titles = createStructuredChatHistoryTitles({ resolveTitles, onChanged })

    // History's placeholder names nothing, so the chat keeps its default label.
    expect(titles.titleFor(chat)).toBeUndefined()
    await vi.waitFor(() => expect(resolveTitles).toHaveBeenCalledTimes(1))
    titles.titleFor(chat)
    expect(resolveTitles).toHaveBeenCalledTimes(1)
    expect(onChanged).not.toHaveBeenCalled()

    historyTitle = 'Fix the login test'
    titles.observe(summary('working'), { replay: false })
    titles.observe(summary('idle'), { replay: false })
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledWith('workspace-1', 'chat-1'))
    expect(titles.titleFor(chat)).toBe('Fix the login test')
  })
})
