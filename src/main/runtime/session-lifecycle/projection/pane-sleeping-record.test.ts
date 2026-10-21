import { describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { findPaneSleepingRecord } from './pane-sleeping-record'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const WORKTREE = 'repo::/work'
const LEFT = '11111111-1111-4111-8111-111111111111'
const RIGHT = '22222222-2222-4222-8222-222222222222'
const RECORD: SleepingAgentSessionRecord = {
  paneKey: 'tab-1:2',
  tabId: 'tab-1',
  worktreeId: WORKTREE,
  agent: 'claude',
  providerSession: { key: 'session_id', id: 'conv-1' },
  prompt: 'finish',
  state: 'done',
  capturedAt: 1,
  updatedAt: 1,
  origin: 'worktree-sleep'
}

function session(root: unknown): WorkspaceSessionState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lookup reads only the records and the tab's layout.
  return {
    sleepingAgentSessionsByPaneKey: { 'tab-1:2': RECORD },
    terminalLayoutsByTabId: { 'tab-1': { root, activeLeafId: LEFT, expandedLeafId: null } }
  } as unknown as WorkspaceSessionState
}

describe("main's lookup of a pane's numbered sleeping record", () => {
  it("takes the tab's one conversation for its one pane", () => {
    expect(
      findPaneSleepingRecord(session({ type: 'leaf', leafId: LEFT }), WORKTREE, {
        parentTabId: 'tab-1',
        leafId: LEFT
      })
    ).toMatchObject({ record: RECORD, aliases: ['tab-1:2'] })
  })

  it('in a split of two agents, takes each pane’s own numbered record, as the window does', () => {
    const split = {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEFT },
      second: { type: 'leaf', leafId: RIGHT }
    }
    const twoAgents = {
      ...session(split),
      sleepingAgentSessionsByPaneKey: {
        'tab-1:1': { ...RECORD, paneKey: 'tab-1:1' },
        'tab-1:2': { ...RECORD, providerSession: { key: 'session_id', id: 'conv-2' } }
      }
    } as WorkspaceSessionState
    const of = (leafId: string) =>
      findPaneSleepingRecord(twoAgents, WORKTREE, { parentTabId: 'tab-1', leafId })?.record
        .providerSession.id
    expect(of(LEFT)).toBe('conv-1')
    expect(of(RIGHT)).toBe('conv-2')
  })

  it('takes nothing in a split for a pane with no number of its own', () => {
    const split = {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEFT },
      second: { type: 'leaf', leafId: RIGHT }
    }
    // The record is numbered 2, the right pane's number; the left pane must not take it.
    expect(
      findPaneSleepingRecord(session(split), WORKTREE, { parentTabId: 'tab-1', leafId: LEFT })
    ).toBeNull()
    expect(
      findPaneSleepingRecord(session(split), WORKTREE, { parentTabId: 'tab-1', leafId: RIGHT })
    ).toMatchObject({ record: RECORD })
  })
})
