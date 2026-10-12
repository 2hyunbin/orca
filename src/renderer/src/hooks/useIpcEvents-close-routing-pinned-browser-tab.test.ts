import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useIpcEventsForCloseRouting,
  type CloseActiveTabListener
} from './ipc-events-close-routing-test-harness'

describe('useIpcEvents pinned browser tab close routing', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    // Undo a partial mock of this module leaked by an earlier describe so the real
    // resolveFloatingWorkspaceBrowserWorkspaceId (source validation) is used here.
    vi.doUnmock('@/lib/floating-workspace-terminal-actions')
  })

  it('confirms before closing a pinned active browser tab from the native close event', async () => {
    const closeActiveTabListenerRef: { current: CloseActiveTabListener | null } = { current: null }
    const closeBrowserTab = vi.fn()
    const requestPinnedTabCloseConfirm = vi.fn()

    await useIpcEventsForCloseRouting({
      closeActiveTabListenerRef,
      getState: () => ({
        recordClientHostedBrowserCloseIntents: vi.fn(),
        closeBrowserTab,
        requestPinnedTabCloseConfirm,
        unifiedTabsByWorktree: {
          'wt-1': [
            {
              id: 'browser-unified-1',
              entityId: 'workspace-1',
              contentType: 'browser',
              label: 'Docs',
              isPinned: true
            }
          ]
        }
      })
    })

    closeActiveTabListenerRef.current?.()

    expect(closeBrowserTab).not.toHaveBeenCalled()
    expect(requestPinnedTabCloseConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ tabLabel: 'Docs', onConfirm: expect.any(Function) })
    )

    const { onConfirm } = requestPinnedTabCloseConfirm.mock.calls[0][0] as { onConfirm: () => void }
    onConfirm()

    expect(closeBrowserTab).toHaveBeenCalledWith('workspace-1', undefined)
  })
})
