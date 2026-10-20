import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { collectLeafIds } from '../../shared/terminal-pane-layout-tree'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { closeExitedSplitPaneInSession } from './exited-split-pane-layout-close'

const WORKTREE = 'repo-1::/w'
const TAB = 'tab-1'
const LEFT = '11111111-1111-4111-8111-111111111111'
const RIGHT = '22222222-2222-4222-8222-222222222222'

function splitSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeWorktreeId: WORKTREE,
    tabsByWorktree: {
      [WORKTREE]: [
        {
          id: TAB,
          ptyId: 'pty-left',
          worktreeId: WORKTREE,
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
      [TAB]: {
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

const cleanExit = { exitCode: 0, freshSpawn: false, inputSeen: true, outputSeen: true, shown: true }
const right = { worktreeId: WORKTREE, parentTabId: TAB, leafId: RIGHT, ptyId: 'pty-right' }

describe('closeExitedSplitPaneInSession', () => {
  it('closes a split pane whose shell exited, leaving its sibling', () => {
    const next = closeExitedSplitPaneInSession(
      LOCAL_EXECUTION_HOST_ID,
      splitSession(),
      right,
      cleanExit
    )
    expect(collectLeafIds(next?.terminalLayoutsByTabId[TAB]?.root)).toEqual([LEFT])
    expect(next?.terminalLayoutsByTabId[TAB]?.ptyIdsByLeafId).toEqual({ [LEFT]: 'pty-left' })
  })

  it('keeps the session as it is for a pane the rule keeps (a failed process’s card)', () => {
    const session = splitSession()
    expect(
      closeExitedSplitPaneInSession(LOCAL_EXECUTION_HOST_ID, session, right, {
        ...cleanExit,
        exitCode: 1
      })
    ).toBe(session)
  })

  it('leaves a tab’s last pane, and a pane another terminal took, to the retirement', () => {
    const session = splitSession()
    expect(
      closeExitedSplitPaneInSession(
        LOCAL_EXECUTION_HOST_ID,
        session,
        { ...right, ptyId: 'pty-old' },
        cleanExit
      )
    ).toBeNull()
    const lone: WorkspaceSessionState = {
      ...session,
      terminalLayoutsByTabId: {
        [TAB]: {
          root: { type: 'leaf', leafId: RIGHT },
          activeLeafId: RIGHT,
          expandedLeafId: null,
          ptyIdsByLeafId: { [RIGHT]: 'pty-right' }
        }
      }
    }
    expect(
      closeExitedSplitPaneInSession(LOCAL_EXECUTION_HOST_ID, lone, right, cleanExit)
    ).toBeNull()
  })
})
