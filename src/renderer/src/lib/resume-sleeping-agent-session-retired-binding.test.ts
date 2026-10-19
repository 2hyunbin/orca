import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import { recordPaneIsOwnedByPreservedPane } from './sleeping-agent-pane-ownership'

const mocks = vi.hoisted(() => ({ layoutOwnerIsMain: false }))

vi.mock('../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))

const initialAppStoreState = useAppStore.getState()
const LEAF_ID = '55555555-5555-4555-8555-555555555555'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)

afterEach(() => {
  mocks.layoutOwnerIsMain = false
  useAppStore.setState(initialAppStoreState, true)
})

const record: SleepingAgentSessionRecord = {
  paneKey: PANE_KEY,
  worktreeId: 'wt-1',
  agent: 'codex',
  providerSession: { key: 'session_id', id: 'sess-retired' },
  prompt: 'keep working',
  state: 'working',
  capturedAt: 1,
  updatedAt: 1,
  origin: 'quit'
}

// The first visit after a reboot: main found the pane's terminal gone and retired its binding
// before the pane's fresh start, so the pane is in the layout with no terminal bound.
function retiredBindingState(): void {
  useAppStore.setState({
    activeWorktreeId: 'wt-1',
    activeTabType: 'terminal',
    activeTabId: 'tab-1',
    activeTabIdByWorktree: { 'wt-1': 'tab-1' },
    tabsByWorktree: {
      'wt-1': [
        {
          id: 'tab-1',
          ptyId: null,
          worktreeId: 'wt-1',
          title: 'codex',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null
      }
    },
    ptyIdsByTabId: {},
    sleepingAgentSessionsByPaneKey: { [PANE_KEY]: record }
  })
}

describe('a resume record whose pane main kept with its terminal binding retired', () => {
  it('is owned by that pane on main-owned layouts, so the sweep leaves it to resume in place', () => {
    mocks.layoutOwnerIsMain = true
    retiredBindingState()

    expect(recordPaneIsOwnedByPreservedPane(record, useAppStore.getState())).toBe(true)
    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)
    const state = useAppStore.getState()
    expect(state.tabsByWorktree['wt-1']?.map((tab) => tab.id)).toEqual(['tab-1'])
    expect(state.sleepingAgentSessionsByPaneKey[PANE_KEY]).toBe(record)
  })

  it('keeps the window-owned rule: an unbound pane does not own it', () => {
    retiredBindingState()

    expect(recordPaneIsOwnedByPreservedPane(record, useAppStore.getState())).toBe(false)
  })
})
