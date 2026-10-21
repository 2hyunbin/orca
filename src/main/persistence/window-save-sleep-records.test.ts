import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { windowSaveKeepingMainSleepRecords } from './window-save-sleep-records'

function record(
  paneKey: string,
  overrides: Partial<SleepingAgentSessionRecord>
): SleepingAgentSessionRecord {
  return {
    paneKey,
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: `session-${paneKey}` },
    prompt: '',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

const mainClaimed = record('tab-a:leaf', {
  origin: 'worktree-sleep',
  restoreOnTabOpenOnly: true
})
const staleWindowCopy = record('tab-a:leaf', { origin: 'worktree-sleep', state: 'working' })
const hibernation = record('tab-b:leaf', { origin: 'worktree-sleep' })
const quit = record('tab-c:leaf', { origin: 'quit' })

describe('windowSaveKeepingMainSleepRecords', () => {
  it("keeps main's workspace-sleep records over the window's copy and passes the rest", () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the merge reads only the records field.
    const stored = {
      sleepingAgentSessionsByPaneKey: { [mainClaimed.paneKey]: mainClaimed }
    } as WorkspaceSessionState
    const saved = windowSaveKeepingMainSleepRecords(stored, {
      sleepingAgentSessionsByPaneKey: {
        [staleWindowCopy.paneKey]: staleWindowCopy,
        [hibernation.paneKey]: hibernation,
        [quit.paneKey]: quit
      }
    })
    expect(saved.sleepingAgentSessionsByPaneKey).toEqual({
      [mainClaimed.paneKey]: mainClaimed,
      [hibernation.paneKey]: hibernation,
      [quit.paneKey]: quit
    })
  })

  it('leaves a save without the field untouched', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the merge reads only the records field.
    const stored = {
      sleepingAgentSessionsByPaneKey: { [mainClaimed.paneKey]: mainClaimed }
    } as WorkspaceSessionState
    const patch = { activeRepoId: 'repo' }
    expect(windowSaveKeepingMainSleepRecords(stored, patch)).toBe(patch)
  })
})
