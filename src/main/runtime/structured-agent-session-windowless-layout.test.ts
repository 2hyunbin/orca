// A chat tab on a host with no window is saved in the host's layout, as a window saves its own:
// opening a chat saves it, closing removes it, and a chat the index restores without one gets one.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { OrcaRuntimeService } from './orca-runtime'

const WT = 'repo-1::/tmp/worktree-a'

afterEach(() => setStructuredAgentSessionHost(null))

function createRuntime() {
  const state: { session: WorkspaceSessionState } = {
    session: {
      activeRepoId: 'repo-1',
      activeWorktreeId: WT,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    }
  }
  const store = {
    getRepos: () => [],
    getSettings: () => ({}),
    getWorkspaceSession: () => state.session,
    getWorkspaceSessionHostIds: () => ['local' as const],
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      state.session = next
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only these store methods on these paths.
  const runtime = new OrcaRuntimeService(store as never)
  return { runtime, state }
}

function savedChatIds(state: { session: WorkspaceSessionState }): string[] {
  return (state.session.unifiedTabs?.[WT] ?? [])
    .filter((tab) => tab.contentType === 'agent-session')
    .map((tab) => tab.entityId)
}

describe('a chat tab on a host with no window', () => {
  it('is saved in the layout once when the chat opens', async () => {
    const { runtime, state } = createRuntime()
    const chat = { workspaceId: WT, sessionId: 'chat-1', agent: 'codex' as const }

    await runtime.publishStructuredAgentSessionTab({ ...chat, activate: true })
    await runtime.publishStructuredAgentSessionTab({ ...chat, activate: true })

    expect(savedChatIds(state)).toEqual(['chat-1'])
  })

  it('leaves the layout when the chat closes', async () => {
    const { runtime, state } = createRuntime()
    await runtime.publishStructuredAgentSessionTab({
      workspaceId: WT,
      sessionId: 'chat-1',
      agent: 'codex',
      activate: true
    })

    expect(savedChatIds(state)).toEqual(['chat-1'])
    expect(runtime.retireStructuredAgentSessionTabFromSnapshot('chat-1')).toBe(true)

    expect(savedChatIds(state)).toEqual([])
  })

  it('is saved at startup for a chat the index restores without one', async () => {
    const { runtime, state } = createRuntime()
    const internal = runtime as unknown as {
      hasPersistedStructuredAgentSessionStore(): boolean
      refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
      ensureStructuredAgentSessionHost(): Promise<void>
    }
    internal.hasPersistedStructuredAgentSessionStore = () => true
    internal.refreshMobileSessionPtyRecords = async () => new Set()
    internal.ensureStructuredAgentSessionHost = async () => undefined
    setStructuredAgentSessionHost({
      reconcileRestartLeases: async () => undefined,
      getPersistedVisibleSessionTabIndex: () => ({ present: true, sessionIds: ['chat-1'] }),
      restoreReadableSessions: async () => undefined,
      listSessionTabs: () => [{ sessionId: 'chat-1', workspaceId: WT, agent: 'codex' }]
    } as never)

    await runtime.restoreStructuredAgentSessionTabs()

    expect(savedChatIds(state)).toEqual(['chat-1'])
  })

  it('is left to the window when one saves the layout', async () => {
    const { runtime, state } = createRuntime()
    vi.spyOn(
      runtime as unknown as { getAvailableAuthoritativeWindow(): unknown },
      'getAvailableAuthoritativeWindow'
    ).mockReturnValue({})

    await runtime.publishStructuredAgentSessionTab({
      workspaceId: WT,
      sessionId: 'chat-1',
      agent: 'codex',
      activate: true
    })

    expect(savedChatIds(state)).toEqual([])
  })
})
