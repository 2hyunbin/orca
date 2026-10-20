import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { collectLeafIds } from '../../shared/terminal-pane-layout-tree'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const WORKTREE_ID = 'repo::/worktree'
const LEFT = '11111111-1111-4111-8111-111111111111'
const RIGHT = '22222222-2222-4222-8222-222222222222'
const LIVE_REPO = {
  id: 'repo',
  path: '/worktree',
  displayName: 'repo',
  badgeColor: 'blue',
  addedAt: 1
}

function splitSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeWorktreeId: WORKTREE_ID,
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: 'tab',
          ptyId: 'pty-left',
          worktreeId: WORKTREE_ID,
          title: 'Terminal 1',
          defaultTitle: 'Terminal 1',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      tab: {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: LEFT },
          second: { type: 'leaf', leafId: RIGHT }
        },
        activeLeafId: RIGHT,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEFT]: 'pty-left', [RIGHT]: 'pty-right' }
      }
    }
  }
}

/** A runtime over one stored session, with the window's two split panes registered. */
function splitRuntime(): { runtime: OrcaRuntimeService; session: () => WorkspaceSessionState } {
  let session = splitSession()
  const runtime = new OrcaRuntimeService({
    getRepos: () => [LIVE_REPO],
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    }
  } as never)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab',
        worktreeId: WORKTREE_ID,
        title: 'Terminal 1',
        activeLeafId: RIGHT,
        layout: session.terminalLayoutsByTabId.tab!.root
      }
    ],
    leaves: [
      { tabId: 'tab', worktreeId: WORKTREE_ID, leafId: LEFT, paneRuntimeId: 1, ptyId: 'pty-left' },
      { tabId: 'tab', worktreeId: WORKTREE_ID, leafId: RIGHT, paneRuntimeId: 2, ptyId: 'pty-right' }
    ]
  })
  return { runtime, session: () => session }
}

const panes = (session: WorkspaceSessionState) =>
  collectLeafIds(session.terminalLayoutsByTabId.tab?.root)

describe('layout-owner build: main closes an exited split pane itself', () => {
  it('closes a split pane whose shell exited cleanly', async () => {
    const { runtime, session } = splitRuntime()
    await runtime.onPtyExit('pty-right', 0, undefined, { providerExitObserved: true })
    expect(panes(session())).toEqual([LEFT])
  })

  it('keeps a split pane whose process failed, behind its "Terminal exited" card', async () => {
    const { runtime, session } = splitRuntime()
    await runtime.onPtyExit('pty-right', 1, undefined, { providerExitObserved: true })
    expect(panes(session())).toEqual([LEFT, RIGHT])
  })

  it('keeps a newborn split that died while shown before any input or output', async () => {
    const { runtime, session } = splitRuntime()
    runtime.terminalRunFacts.recordSpawnCommit({ id: 'pty-right' }, { ptyId: 'pty-left' })
    await runtime.onPtyExit('pty-right', 0, undefined, {
      providerExitObserved: true,
      viewShown: true
    })
    expect(panes(session())).toEqual([LEFT, RIGHT])
  })

  it('closes that newborn split when it ended unseen, as a hidden pane always closed', async () => {
    const { runtime, session } = splitRuntime()
    runtime.terminalRunFacts.recordSpawnCommit({ id: 'pty-right' }, { ptyId: 'pty-left' })
    await runtime.onPtyExit('pty-right', 0, undefined, { providerExitObserved: true })
    expect(panes(session())).toEqual([LEFT])
  })
})
