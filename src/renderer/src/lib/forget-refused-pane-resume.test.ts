import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { createTestStore, makeTab } from '@/store/slices/store-test-helpers'
import { forgetRefusedPaneResume } from './forget-refused-pane-resume'

const PANE = 'tab-floating:11111111-1111-4111-8111-111111111111'
const SIBLING = 'tab-floating:22222222-2222-4222-8222-222222222222'
const CHAT = { key: 'session_id' as const, id: 'chat-session' }
const TITLE = { agent: 'claude' as const, sessionId: CHAT.id, title: 'the chat prompt' }

function saved(paneKey: string, id: string): SleepingAgentSessionRecord {
  const providerSession = { key: 'session_id' as const, id }
  return {
    paneKey,
    worktreeId: 'wt',
    agent: 'claude',
    providerSession,
    prompt: '',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1
  }
}

describe('forgetRefusedPaneResume', () => {
  it("forgets the chat conversation as this pane's resume, and leaves the chat and other panes alone", () => {
    const store = createTestStore()
    store.setState({
      sleepingAgentSessionsByPaneKey: {
        [PANE]: saved(PANE, CHAT.id),
        'tab-floating:1': saved('tab-floating:1', CHAT.id),
        // A split sibling is another pane, refused at its own restore.
        [SIBLING]: saved(SIBLING, CHAT.id),
        // Another pane's copy is refused and forgotten at that pane's own restore.
        'tab-other:leaf': saved('tab-other:leaf', CHAT.id)
      },
      tabsByWorktree: {
        wt: [makeTab({ id: 'tab-floating', worktreeId: 'wt', aiVaultTitle: TITLE })],
        chat: [makeTab({ id: 'tab-chat', worktreeId: 'chat', aiVaultTitle: TITLE })]
      }
    })
    store.getState().registerAgentLaunchConfig(PANE, { agentArgs: '', agentEnv: {} }, {})

    forgetRefusedPaneResume(store.getState(), PANE, { agent: 'claude', providerSession: CHAT })

    const state = store.getState()
    expect(Object.keys(state.sleepingAgentSessionsByPaneKey)).toEqual([SIBLING, 'tab-other:leaf'])
    expect(state.agentLaunchConfigByPaneKey[PANE]).toBeUndefined()
    expect(state.tabsByWorktree.wt![0]!.aiVaultTitle).toBeNull()
    expect(state.tabsByWorktree.chat![0]!.aiVaultTitle).toEqual(TITLE)
  })
})
