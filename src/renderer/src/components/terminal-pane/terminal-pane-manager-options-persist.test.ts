import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import { createTerminalPaneManagerOptions } from './terminal-pane-manager-options'
import type { TerminalPaneManagerOptionsContext } from './terminal-pane-mount-context'

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))

let storeState = createInitialStoreState(() => storeState)
vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))

function createOptions(shouldPersistLayout = true, worktreeId = 'wt') {
  const persistLayoutSnapshot = vi.fn()
  const context = {
    deps: {
      persistLayoutSnapshot,
      syncExpandedLayout: vi.fn(),
      tabId: 'tab',
      worktreeId,
      isVisibleRef: { current: true },
      settingsRef: { current: null },
      effectiveMacOptionAsAltRef: { current: 'false' }
    },
    ptyDeps: {},
    syncCanExpandState: vi.fn(),
    syncPaneCount: vi.fn(),
    syncPaneLayoutRevision: vi.fn(),
    queueResizeAll: vi.fn(),
    shouldPersistLayout: () => shouldPersistLayout
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: building options and running onLayoutChanged read only these fields.
  const optionsContext = context as unknown as TerminalPaneManagerOptionsContext
  const options = createTerminalPaneManagerOptions(optionsContext)
  return { options, persistLayoutSnapshot }
}

describe('terminal pane manager layout persist wiring', () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each([false, true])(
    'classifies the recorded pane backend independently of the active host (%s)',
    (mirror) => {
      vi.stubGlobal('navigator', { userAgent: 'Windows' })
      vi.stubGlobal('window', { api: { platform: { get: () => ({ osRelease: '10.0.22631' }) } } })
      storeState = createInitialStoreState(() => storeState)
      const worktreeId = 'folder:unavailable'
      const leafId = '11111111-1111-4111-8111-111111111111'
      Object.assign(storeState, {
        activeWorktreeId: 'foreign',
        folderWorkspaces: [],
        projectGroups: [],
        tabsByWorktree: { [worktreeId]: [{ id: 'tab', ptyId: null }] },
        unifiedTabsByWorktree: {
          [worktreeId]: [
            { id: 'u', contentType: 'terminal', entityId: 'tab', executionHostId: 'local' }
          ]
        },
        terminalLayoutsByTabId: {
          tab: {
            root: { type: 'leaf', leafId },
            activeLeafId: leafId,
            ptyIdsByLeafId: { [leafId]: mirror ? 'remote:server@@pty-live' : 'pty-local' }
          }
        }
      })
      const { options } = createOptions(true, worktreeId)
      const resolved =
        typeof options.terminalOptions === 'function'
          ? options.terminalOptions()
          : options.terminalOptions
      expect(resolved?.windowsPty).toEqual(
        mirror ? undefined : { backend: 'conpty', buildNumber: 22631 }
      )
      expect(resolved?.vtExtensions).toEqual(mirror ? undefined : { kittyKeyboard: false })
    }
  )

  it('persists a layout change', () => {
    const { options, persistLayoutSnapshot } = createOptions()
    options.onLayoutChanged?.()
    expect(persistLayoutSnapshot).toHaveBeenCalledOnce()
  })

  it('keeps the persist gate', () => {
    const { options, persistLayoutSnapshot } = createOptions(false)
    options.onLayoutChanged?.()
    expect(persistLayoutSnapshot).not.toHaveBeenCalled()
  })
})
