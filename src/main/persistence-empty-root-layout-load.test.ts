import {
  closeTestStores,
  testState,
  createStore,
  writeDataFile,
  makeRepo,
  makeTerminalTab
} from './persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { WorkspaceSessionState } from '../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../shared/constants'
import { TEST_LEAF_1 } from './persistence-session-fixtures'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const WORKTREE_ID = 'repo-1::/worktree'
const EMPTY_ROOT = { root: null, activeLeafId: null, expandedLeafId: null }

// A session saved before tabs named their first pane: the tab exists, its layout has no root.
function oldEmptyRootSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeRepoId: 'repo-1',
    activeWorktreeId: WORKTREE_ID,
    activeTabId: 'tab-1',
    tabsByWorktree: {
      [WORKTREE_ID]: [makeTerminalTab({ id: 'tab-1', worktreeId: WORKTREE_ID, ptyId: null })]
    },
    terminalLayoutsByTabId: { 'tab-1': { ...EMPTY_ROOT } }
  }
}

function loadOldSession() {
  writeDataFile({
    schemaVersion: 1,
    repos: [makeRepo({ id: 'repo-1', path: '/repo-1' })],
    workspaceSession: oldEmptyRootSession()
  })
  return createStore()
}

describe('a saved layout with an empty root', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('loads, and takes the pane the window mounts once its terminal starts', async () => {
    const store = loadOldSession()
    expect(store.getWorkspaceSession().terminalLayoutsByTabId['tab-1']).toEqual(EMPTY_ROOT)

    // The window saves the loaded empty root before mount, then the named pane at mount, then the
    // terminal starts; one window's messages reach main in that order.
    store.setWorkspaceSession(oldEmptyRootSession())
    store.setWorkspaceSession({
      ...oldEmptyRootSession(),
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null
        }
      }
    })
    await store.persistPtyBinding({
      worktreeId: WORKTREE_ID,
      tabId: 'tab-1',
      leafId: TEST_LEAF_1,
      ptyId: 'pty-1'
    })

    expect(store.getWorkspaceSession().terminalLayoutsByTabId['tab-1']).toEqual({
      root: { type: 'leaf', leafId: TEST_LEAF_1 },
      activeLeafId: TEST_LEAF_1,
      expandedLeafId: null,
      ptyIdsByLeafId: { [TEST_LEAF_1]: 'pty-1' }
    })
  })

  it('gets a root when main binds its terminal before the window mounts it', async () => {
    const store = loadOldSession()

    await store.persistPtyBinding({
      worktreeId: WORKTREE_ID,
      tabId: 'tab-1',
      leafId: TEST_LEAF_1,
      ptyId: 'pty-1'
    })

    expect(store.getWorkspaceSession().terminalLayoutsByTabId['tab-1']).toEqual({
      root: { type: 'leaf', leafId: TEST_LEAF_1 },
      activeLeafId: TEST_LEAF_1,
      expandedLeafId: null,
      ptyIdsByLeafId: { [TEST_LEAF_1]: 'pty-1' }
    })
  })
})
