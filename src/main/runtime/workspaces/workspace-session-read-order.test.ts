import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type {
  BrowserTabInfo,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

const WORKTREE_ID = 'repo::/workspace'

describe('workspace session callable lookup order', () => {
  it('keeps the native refusal for a launcher without a workspace selector', async () => {
    const runtime = new OrcaRuntimeService(null)
    await expect(
      runtime.resolveOrchestrationAgentLauncherForTarget('missing-launcher', {})
    ).rejects.toBeInstanceOf(TypeError)
  })

  it('captures the browser reader before evaluating the snapshot workspace getter', () => {
    const runtime = new OrcaRuntimeService(null)
    const order: string[] = []
    const replacement = vi.fn(() => new Map<string, BrowserTabInfo>())
    const original = function (this: InstanceType<typeof OrcaRuntimeService>, worktreeId: string) {
      expect(this).toBe(runtime)
      expect(worktreeId).toBe(WORKTREE_ID)
      order.push('original call')
      return new Map<string, BrowserTabInfo>()
    }
    Object.defineProperty(runtime, 'getLiveBrowserTabsByPageId', {
      configurable: true,
      get: () => {
        order.push('reader lookup')
        return original
      }
    })
    const snapshot: RuntimeMobileSessionTabsSnapshot = {
      worktree: WORKTREE_ID,
      publicationEpoch: 'seed',
      snapshotVersion: 1,
      tabs: [],
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null
    }
    Object.defineProperty(snapshot, 'worktree', {
      get: () => {
        order.push('argument lookup')
        Object.defineProperty(runtime, 'getLiveBrowserTabsByPageId', { value: replacement })
        return WORKTREE_ID
      }
    })
    expect(runtime['collectPublicMobileSessionTabIds'](snapshot)).toEqual(new Set())
    expect(order).toEqual(['reader lookup', 'argument lookup', 'original call'])
    expect(replacement).not.toHaveBeenCalled()
  })

  it('captures the title writer before constructing a session with getter-backed fields', () => {
    const runtime = new OrcaRuntimeService(null)
    const order: string[] = []
    const replacement = vi.fn()
    const original = function (
      this: InstanceType<typeof OrcaRuntimeService>,
      worktreeId: string,
      session: WorkspaceSessionState
    ) {
      expect(this).toBe(runtime)
      expect(worktreeId).toBe(WORKTREE_ID)
      expect(session.tabsByWorktree[WORKTREE_ID]?.[0]?.customTitle).toBe('renamed')
      order.push('original write')
    }
    const session = getDefaultWorkspaceSession()
    const tabs: WorkspaceSessionState['tabsByWorktree'] = {
      [WORKTREE_ID]: [
        {
          id: 'tab',
          ptyId: null,
          worktreeId: WORKTREE_ID,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    }
    let tabReads = 0
    Object.defineProperty(session, 'tabsByWorktree', {
      enumerable: true,
      get: () => {
        tabReads += 1
        if (tabReads === 2) {
          order.push('session spread')
          Object.defineProperty(runtime, 'setWorkspaceSessionForWorktree', { value: replacement })
        }
        return tabs
      }
    })
    Object.defineProperty(runtime, 'store', { value: { setWorkspaceSession: () => {} } })
    Object.defineProperty(runtime, 'getWorkspaceSessionForWorktree', { value: () => session })
    Object.defineProperty(runtime, 'setWorkspaceSessionForWorktree', {
      configurable: true,
      get: () => {
        order.push('writer lookup')
        return original
      }
    })
    runtime['persistHeadlessTerminalTitle'](WORKTREE_ID, 'tab', 'renamed')
    expect(order).toEqual(['writer lookup', 'session spread', 'original write'])
    expect(replacement).not.toHaveBeenCalled()
  })
})
