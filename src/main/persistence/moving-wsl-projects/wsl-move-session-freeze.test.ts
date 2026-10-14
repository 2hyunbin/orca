import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { Store } from '../../persistence'
import {
  closeTestStores,
  createStore,
  makeTerminalTab,
  testState
} from '../../persistence-test-harness'
import { wslMoveCutoverFixture as cutover } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { writeWslMoveCutover } from './wsl-move-cutover-journal'
import { loadWslMoveFence, resetWslMoveFenceForTests } from './wsl-move-scope-guard'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const MOVING = 'repo-1::/home/dev/repo-1'
const STAYING = 'repo-2::/home/dev/repo-2'

function session(title: string, tabType: 'terminal' | 'editor'): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [MOVING]: [makeTerminalTab({ id: 'moving-tab', ptyId: null, worktreeId: MOVING, title })],
      [STAYING]: [makeTerminalTab({ id: 'staying-tab', ptyId: null, worktreeId: STAYING, title })]
    },
    terminalLayoutsByTabId: {
      'moving-tab': { root: null, activeLeafId: null, expandedLeafId: null },
      'staying-tab': { root: null, activeLeafId: null, expandedLeafId: null }
    },
    activeTabTypeByWorktree: { [MOVING]: tabType, [STAYING]: tabType }
  }
}

const titles = (store: Store) => {
  const { tabsByWorktree } = store.getWorkspaceSession()
  return {
    moving: tabsByWorktree[MOVING]?.map((tab) => tab.title),
    staying: tabsByWorktree[STAYING]?.map((tab) => tab.title)
  }
}

let store: Store
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'wsl-move-freeze-'))
  store = createStore()
  loadWslMoveFence(testState.dir)
  store.setWorkspaceSession(session('slept', 'terminal'))
})
afterEach(async () => {
  resetWslMoveFenceForTests()
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('WSL move session freeze', () => {
  it("lets the quiesce's own Sleep write while the move is only fenced", () => {
    writeWslMoveCutover(testState.dir, cutover('move-1', 'source-fenced'))
    store.setWorkspaceSession(session('after-sleep', 'terminal'))
    expect(titles(store)).toEqual({ moving: ['after-sleep'], staying: ['after-sleep'] })
  })

  describe('once quiesced', () => {
    beforeEach(() => {
      writeWslMoveCutover(testState.dir, cutover('move-1', 'quiesced'))
    })

    it('keeps the moving workspace as the quiesce left it and takes the rest', () => {
      store.setWorkspaceSession(session('edited', 'editor'))
      expect(titles(store)).toEqual({ moving: ['slept'], staying: ['edited'] })
      expect(store.getWorkspaceSession().activeTabTypeByWorktree).toEqual({
        [MOVING]: 'terminal',
        [STAYING]: 'editor'
      })
    })

    it('keeps it when a write omits the workspace entirely', () => {
      const without = session('edited', 'editor')
      delete without.tabsByWorktree[MOVING]
      store.setWorkspaceSession(without)
      expect(titles(store)).toEqual({ moving: ['slept'], staying: ['edited'] })
    })

    it('keeps it through a patch and the before-unload stage', () => {
      store.patchWorkspaceSession({
        activeTabTypeByWorktree: { [MOVING]: 'editor', [STAYING]: 'editor' }
      })
      expect(store.getWorkspaceSession().activeTabTypeByWorktree).toEqual({
        [MOVING]: 'terminal',
        [STAYING]: 'editor'
      })
      store.stageWorkspaceSessionBeforeUnload(session('quit', 'editor'))
      expect(titles(store)).toEqual({ moving: ['slept'], staying: ['quit'] })
    })
  })

  it('stops freezing once the WSL host owns the project', () => {
    writeWslMoveCutover(testState.dir, cutover('move-1', 'destination-committed'))
    store.setWorkspaceSession(session('edited', 'editor'))
    expect(titles(store)).toEqual({ moving: ['edited'], staying: ['edited'] })
  })
})
