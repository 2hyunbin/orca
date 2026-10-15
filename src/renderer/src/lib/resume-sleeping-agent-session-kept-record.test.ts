import { afterEach, describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)
const PTY_ID = 'wt-1@@resumed'

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

/** A pane whose cold restore just relaunched its agent and kept the record naming it. */
function seedResumedPane(record: SleepingAgentSessionRecord): void {
  const tab = { id: 'tab-1', ptyId: PTY_ID, worktreeId: 'wt-1', title: 'codex', createdAt: 1 }
  const layout = {
    root: { type: 'leaf', leafId: LEAF_ID },
    activeLeafId: LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId: { [LEAF_ID]: PTY_ID }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the partial carries every store field the activation sweep reads.
  const seeded = {
    activeWorktreeId: 'wt-1',
    activeTabType: 'terminal',
    activeTabId: 'tab-1',
    tabsByWorktree: { 'wt-1': [tab] },
    terminalLayoutsByTabId: { 'tab-1': layout },
    ptyIdsByTabId: { 'tab-1': [PTY_ID] },
    sleepingAgentSessionsByPaneKey: { [PANE_KEY]: record }
  } as unknown as Partial<ReturnType<typeof useAppStore.getState>>
  useAppStore.setState(seeded)
}

function keptRecord(fields: Partial<SleepingAgentSessionRecord>): SleepingAgentSessionRecord {
  return {
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'codex-session-1' },
    prompt: '',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1,
    ...fields
  }
}

describe('activation sweep over a record kept by an in-place resume', () => {
  it.each([
    ['a quit capture', keptRecord({ origin: 'quit' })],
    ['a mid-turn live checkpoint', keptRecord({ origin: 'live', state: 'working' })],
    [
      'the record a silent resume leaves',
      keptRecord({ origin: 'quit', restoreOnTabOpenOnly: true })
    ]
  ])('does not launch a second resume for %s', (_label, record) => {
    seedResumedPane(record)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    expect(launched).toBe(0)
    expect(state.tabsByWorktree['wt-1']).toHaveLength(1)
    expect(state.sleepingAgentSessionsByPaneKey[PANE_KEY]).toBe(record)
  })
})
