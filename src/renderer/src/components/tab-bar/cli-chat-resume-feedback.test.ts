import { beforeEach, expect, it, vi } from 'vitest'
import type { CliChatResumeSource } from './cli-chat-resume-source'
const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  resume: vi.fn(),
  call: vi.fn(),
  activate: vi.fn()
}))
vi.mock('../native-chat/native-chat-held-terminal', () => ({ toastHeldTerminal: mocks.toast }))
vi.mock('../right-sidebar/ai-vault-session-resume-in-chat-launch', () => ({
  resumeCliConversationInNewChat: mocks.resume
}))
vi.mock('@/lib/structured-agent-session-launch-surface', () => ({
  captureStructuredLaunchSurfaceAddress: () => ({
    worktreeId: 'w',
    precedingTabIds: ['before', 'source']
  })
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  supportsInPlaceSwitch: async () => true
}))
vi.mock('@/lib/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: mocks.activate,
  activateAiVaultStructuredSessionVerified: mocks.activate
}))
import { startCliChatReturn, toastCliChatResumeFailure } from './cli-chat-resume-feedback'
const source: CliChatResumeSource = {
  tabId: 'source',
  workspaceId: 'w',
  paneKey: 'source:l',
  agent: 'codex',
  providerSessionId: 'conversation',
  executionHostId: 'local',
  ptyId: 'pty'
}
const refusal = {
  code: 'agent_session_operation_invalid',
  message: 'held',
  details: {
    reason: 'conversationOpenInTerminal',
    terminal: { paneKey: 'source:l', worktreeId: 'w' }
  }
}
beforeEach(() => vi.clearAllMocks())
it('create recovery retains identity and slot without recapturing or retiring its removed source', async () => {
  toastCliChatResumeFailure(source, Object.assign(new Error('held'), { refusal }))
  const recovery = mocks.toast.mock.calls[0][0]
  await recovery.onContinue()
  expect(mocks.resume).toHaveBeenCalledExactlyOnceWith({
    rowAgent: 'codex',
    executionHostId: 'local',
    worktreeId: 'w',
    providerSessionId: 'conversation',
    surfaceAddress: { worktreeId: 'w', precedingTabIds: ['before', 'source'] }
  })
})
it('switch recovery switches and reveals the same existing chat after its source is gone', async () => {
  mocks.call.mockResolvedValueOnce({ ok: false, refusal }).mockResolvedValueOnce({ ok: true })
  expect(await startCliChatReturn(source, 'existing', { kind: 'local' })).toBe(false)
  await mocks.toast.mock.calls[0][0].onContinue()
  expect(mocks.call).toHaveBeenNthCalledWith(2, { kind: 'local' }, 'agentSession.switchToChat', {
    sessionId: 'existing'
  })
  expect(mocks.resume).not.toHaveBeenCalled()
  expect(mocks.activate).toHaveBeenCalledExactlyOnceWith(
    { structuredSession: { sessionId: 'existing', workspaceId: 'w' } },
    undefined,
    { kind: 'local' }
  )
})
