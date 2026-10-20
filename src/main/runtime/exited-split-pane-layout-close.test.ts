import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { keptExitedPaneSession } from './exited-split-pane-layout-close'

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

describe('keptExitedPaneSession', () => {
  it('leaves a split pane whose shell exited cleanly, or that main stopped, to the retirement', () => {
    expect(keptExitedPaneSession(splitSession(), right, cleanExit)).toBeNull()
    expect(keptExitedPaneSession(splitSession(), right, { ...cleanExit, exitCode: -1 })).toBeNull()
  })

  it('keeps the session as it is for a pane the rule keeps (a failed process’s card)', () => {
    const session = splitSession()
    expect(
      keptExitedPaneSession(session, right, {
        ...cleanExit,
        exitCode: 1
      })
    ).toBe(session)
  })

  it('leaves a tab’s last pane, and a pane another terminal took, to the retirement', () => {
    const session = splitSession()
    expect(keptExitedPaneSession(session, { ...right, ptyId: 'pty-old' }, cleanExit)).toBeNull()
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
    expect(keptExitedPaneSession(lone, right, cleanExit)).toBeNull()
  })

  it('keeps a tab’s last pane behind its card when its process failed or died unused', () => {
    const session = splitSession()
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
    const exit = (facts: Partial<typeof cleanExit>) =>
      keptExitedPaneSession(lone, right, {
        ...cleanExit,
        ...facts
      })
    expect(exit({ exitCode: 1 })).toBe(lone)
    expect(exit({ freshSpawn: true, inputSeen: false, shown: false })).toBe(lone)
    expect(exit({ freshSpawn: true, inputSeen: true })).toBeNull()
  })
})
