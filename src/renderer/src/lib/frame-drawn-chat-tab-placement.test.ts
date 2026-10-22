import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const groupsByWorktree: Record<string, { id: string; tabOrder: string[] }[]> = {}
  const unifiedTabsByWorktree: Record<string, { id: string; entityId: string }[]> = {}
  const noted: string[][] = []
  return {
    state: { groupsByWorktree, unifiedTabsByWorktree },
    frameDrawn: true,
    supported: true,
    created: new Set<string>(),
    noted
  }
})

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: vi.fn(async () => mocks.supported)
}))
vi.mock('@/runtime/web-session-tabs-sync/frame-drawn-server-workspaces', () => ({
  isFrameDrawnServerWorkspace: () => mocks.frameDrawn
}))
vi.mock('./desktop-created-server-tabs', () => ({
  isDesktopCreatedServerTab: (_tabs: unknown, _workspace: string, id: string) =>
    mocks.created.has(id),
  noteDesktopCreatedServerTab: (...args: string[]) => mocks.noted.push(args)
}))

import type { StructuredAgentSessionCreateParams } from '../../../shared/structured-agent-session-create'
import {
  holdFrameDrawnProvisionalChatTab,
  withFrameDrawnChatTabPlacement
} from './frame-drawn-chat-tab-placement'

const TAB = 'structured-agent-session-claude_1'
const params: StructuredAgentSessionCreateParams = {
  envelope: {
    sessionId: 'claude_1',
    clientOperationId: 'op-1',
    expectedRuntimeFence: null,
    payloadFingerprint: 'fp'
  },
  worktree: 'id:wt',
  agent: 'claude'
}
const intent = {
  target: { kind: 'environment', environmentId: 'env-1' } as const,
  worktreeId: 'wt',
  sessionId: 'claude_1',
  params
}

describe('a chat opened in a frame-drawn server workspace (L270)', () => {
  beforeEach(() => {
    mocks.frameDrawn = true
    mocks.supported = true
    mocks.created = new Set()
    mocks.noted = []
    mocks.state.groupsByWorktree = {
      wt: [
        { id: 'g-1', tabOrder: ['terminal-surface:pty-1'] },
        { id: 'g-2', tabOrder: ['editor-1', 'sim-1', TAB, 'editor-2'] }
      ]
    }
    mocks.state.unifiedTabsByWorktree = { wt: [] }
  })

  it("names the tab's group and the server tab before it, skipping this desktop's own tabs", async () => {
    mocks.created.add('sim-1')
    await expect(withFrameDrawnChatTabPlacement(intent)).resolves.toEqual({
      ...params,
      tabPlacement: { groupId: 'g-2', afterTabId: 'editor-1' }
    })
  })

  it('names the group alone when no server tab comes before the chat', async () => {
    mocks.state.groupsByWorktree.wt[1].tabOrder = [TAB, 'editor-2']
    await expect(withFrameDrawnChatTabPlacement(intent)).resolves.toEqual({
      ...params,
      tabPlacement: { groupId: 'g-2' }
    })
  })

  it('sends no place to a host without the capability', async () => {
    mocks.supported = false
    await expect(withFrameDrawnChatTabPlacement(intent)).resolves.toBe(intent.params)
  })

  it('sends no place, and holds nothing, outside a frame-drawn workspace', async () => {
    mocks.frameDrawn = false
    await expect(withFrameDrawnChatTabPlacement(intent)).resolves.toBe(intent.params)
    holdFrameDrawnProvisionalChatTab(intent.target, 'wt', TAB)
    holdFrameDrawnProvisionalChatTab({ kind: 'local' }, 'wt', TAB)
    expect(mocks.noted).toEqual([])
  })

  it('holds the provisional tab for its server until the server lists it', () => {
    holdFrameDrawnProvisionalChatTab(intent.target, 'wt', TAB)
    expect(mocks.noted).toEqual([['env-1', 'wt', TAB]])
  })
})
