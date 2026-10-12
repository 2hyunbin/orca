import { describe, expect, it, vi } from 'vitest'
import {
  openWorkspaceDefaultAgentChat,
  type WorkspaceDefaultAgentChatPorts
} from './workspace-default-agent-chat'

function ports(overrides: Partial<WorkspaceDefaultAgentChatPorts> = {}) {
  return {
    settings: { experimentalNativeChat: true, defaultTuiAgent: 'claude' as const },
    detectAgents: vi.fn(async () => ['claude', 'codex']),
    opensAsChat: vi.fn(async () => true),
    createChat: vi.fn(async () => {}),
    ...overrides
  }
}

describe('openWorkspaceDefaultAgentChat', () => {
  it("opens the user's default agent as a chat", async () => {
    const seed = ports()
    await expect(openWorkspaceDefaultAgentChat(seed)).resolves.toBe(true)
    expect(seed.createChat).toHaveBeenCalledWith('claude')
  })

  it.each([
    ['chat is off', { experimentalNativeChat: false, defaultTuiAgent: 'claude' as const }],
    ['the default is blank', { experimentalNativeChat: true, defaultTuiAgent: 'blank' as const }]
  ])('opens nothing when %s', async (_case, settings) => {
    const seed = ports({ settings })
    await expect(openWorkspaceDefaultAgentChat(seed)).resolves.toBe(false)
    expect(seed.detectAgents).not.toHaveBeenCalled()
    expect(seed.createChat).not.toHaveBeenCalled()
  })

  it('opens nothing for an agent that would only open as a terminal here', async () => {
    const seed = ports({ opensAsChat: vi.fn(async () => false) })
    await expect(openWorkspaceDefaultAgentChat(seed)).resolves.toBe(false)
    expect(seed.createChat).not.toHaveBeenCalled()
  })

  it('reports nothing opened when the host refuses the chat, so the shell is seeded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seed = ports({
      createChat: vi.fn(async () => {
        throw new Error('structured_agent_session_unsupported')
      })
    })
    await expect(openWorkspaceDefaultAgentChat(seed)).resolves.toBe(false)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('picks a detected agent when the default names none', async () => {
    const seed = ports({
      settings: { experimentalNativeChat: true },
      detectAgents: vi.fn(async () => ['codex'])
    })
    await expect(openWorkspaceDefaultAgentChat(seed)).resolves.toBe(true)
    expect(seed.createChat).toHaveBeenCalledWith('codex')
  })
})
