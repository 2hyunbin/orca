import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WorktreeMetaPersistModule from '../metadata/worktree-meta-persist'
import { persistWorktreeMeta } from '../metadata/worktree-meta-persist'
import { WORKSPACE_UNREAD_HOST_RAISES_CAPABILITY } from '../../../../../../shared/workspace-unread-raise-capability'
import { createTestStore, makeWorktree, TEST_REPO } from '../../store-test-helpers'

// The owning host writes Recent stamps; the window stamps only rows of an older paired server.

const hostCapabilities = vi.hoisted(() => new Map<string, readonly string[]>())

vi.mock('../metadata/worktree-meta-persist', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeMetaPersistModule>()
  return { ...actual, persistWorktreeMeta: vi.fn(async () => undefined) }
})
vi.mock('@/runtime/runtime-rpc-client', () => ({
  readCachedRuntimeEnvironmentCapability: () => null,
  runtimeEnvironmentSupportsCapability: vi.fn(async (environmentId: string, capability: string) => {
    const capabilities = hostCapabilities.get(environmentId)
    if (!capabilities) {
      throw new Error('runtime unreachable')
    }
    return capabilities.includes(capability)
  })
}))
vi.mock('../listing/worktree-owner-target', () => ({
  // `/server-<env>/` paths belong to that paired server; the rest to this app.
  tryRuntimeTargetForWorktreeOwner: (_state: unknown, workspaceId: string) => {
    const environmentId = /\/server-([^/]+)\//.exec(workspaceId)?.[1]
    return environmentId ? { kind: 'environment', environmentId } : { kind: 'local' }
  }
}))

const LOCAL_WT = 'repo1::/path/local/a'
const NEW_SERVER_WT = 'repo1::/path/server-new/a'
const OLD_SERVER_WT = 'repo1::/path/server-old/a'
const UNREACHABLE_SERVER_WT = 'repo1::/path/server-unreachable/a'

function createStore() {
  const store = createTestStore()
  store.setState({
    repos: [{ ...TEST_REPO, executionHostId: 'local' }],
    worktreesByRepo: {
      repo1: [LOCAL_WT, NEW_SERVER_WT, OLD_SERVER_WT, UNREACHABLE_SERVER_WT].map((id) =>
        makeWorktree({ id, repoId: 'repo1', path: id.replace('repo1::', ''), lastActivityAt: 1 })
      )
    }
  })
  const bump = async (id: string): Promise<void> => {
    store.getState().bumpWorktreeActivity(id)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return { bump }
}

beforeEach(() => {
  vi.clearAllMocks()
  hostCapabilities.clear()
  hostCapabilities.set('new', [WORKSPACE_UNREAD_HOST_RAISES_CAPABILITY])
  hostCapabilities.set('old', ['runtime.status.compat.v1'])
})

describe('terminal activity stamps Recent only where the owning host does not', () => {
  it('leaves it to this app’s main and to a paired server that stamps', async () => {
    const { bump } = createStore()
    await bump(LOCAL_WT)
    await bump(NEW_SERVER_WT)
    expect(persistWorktreeMeta).not.toHaveBeenCalled()
  })

  it('stamps an older or unreadable paired server’s row on that server', async () => {
    const { bump } = createStore()
    await bump(OLD_SERVER_WT)
    await bump(UNREACHABLE_SERVER_WT)
    expect(persistWorktreeMeta).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'old' },
      OLD_SERVER_WT,
      { lastActivityAt: expect.any(Number) }
    )
    expect(persistWorktreeMeta).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'unreachable' },
      UNREACHABLE_SERVER_WT,
      { lastActivityAt: expect.any(Number) }
    )
  })
})
