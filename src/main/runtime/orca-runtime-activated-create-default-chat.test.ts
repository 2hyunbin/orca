import './orca-runtime-test-lifecycle.spec'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  OrcaRuntimeService,
  computeWorktreePathMock,
  ensurePathWithinWorkspaceMock,
  listWorktrees
} from './orca-runtime-test-mocks.spec'
import { store } from './orca-runtime-test-fixtures.spec'

const { detectAgentsOnHost, createStructuredAgentSessionForWorktree } = vi.hoisted(() => ({
  detectAgentsOnHost: vi.fn(async () => ['claude']),
  createStructuredAgentSessionForWorktree: vi.fn(async () => ({
    ok: true,
    value: { sessionId: 'session-1', fence: 1 }
  }))
}))
vi.mock('../preflight/workspace-agent-detection', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  detectAgentsOnHost
}))
vi.mock('./rpc/methods/structured-agent-session-create', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createStructuredAgentSessionForWorktree
}))

async function createActivated(settings: Record<string, unknown>) {
  const runtime = new OrcaRuntimeService({
    ...store,
    getSettings: () => ({ ...store.getSettings(), ...settings })
  })
  onTestFinished(() => runtime.markGraphUnavailable(1))
  runtime.setPtyController({
    spawn: vi.fn(),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
    supported: true
  })
  const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
    handle: 'shell',
    worktreeId: 'created-worktree',
    title: null,
    surface: 'background'
  })
  const worktreePath = '/tmp/workspaces/default-chat'
  computeWorktreePathMock.mockReturnValue(worktreePath)
  ensurePathWithinWorkspaceMock.mockReturnValue(worktreePath)
  vi.mocked(listWorktrees).mockResolvedValue([
    {
      path: worktreePath,
      head: 'abc',
      branch: 'default-chat',
      isBare: false,
      isMainWorktree: false
    }
  ])
  await runtime.createManagedWorktree({
    repoSelector: 'id:repo-1',
    name: 'default-chat',
    activate: true
  })
  return { createTerminal }
}

describe('a CLI create --activate seeds the default agent chat (plan O2)', () => {
  it("opens the configured default agent's chat instead of a shell", async () => {
    createStructuredAgentSessionForWorktree.mockClear()
    const { createTerminal } = await createActivated({
      experimentalNativeChat: true,
      defaultTuiAgent: 'claude'
    })
    expect(createStructuredAgentSessionForWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'claude', activate: true })
    )
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('opens a shell when new agent tabs open as terminals', async () => {
    createStructuredAgentSessionForWorktree.mockClear()
    const { createTerminal } = await createActivated({
      experimentalNativeChat: false,
      defaultTuiAgent: 'claude'
    })
    expect(createStructuredAgentSessionForWorktree).not.toHaveBeenCalled()
    expect(createTerminal).toHaveBeenCalledTimes(1)
  })
})
