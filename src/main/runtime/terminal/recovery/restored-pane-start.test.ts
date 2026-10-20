import { describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import {
  RestoredPaneStarter,
  restoredPaneStartPlan,
  type RestoredPane,
  type RestoredPaneStartPorts
} from './restored-pane-start'

const PANE: RestoredPane = {
  worktreeId: 'repo-1::/repo',
  tabId: 'tab-1',
  leafId: '11111111-1111-4111-8111-111111111111'
}
const OWN = 'repo-1::/repo@@abc'

const record = (over: Partial<SleepingAgentSessionRecord> = {}): SleepingAgentSessionRecord => ({
  paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
  tabId: 'tab-1',
  worktreeId: PANE.worktreeId,
  agent: 'codex',
  providerSession: { key: 'session_id', id: 's-1' },
  prompt: 'p',
  state: 'working',
  capturedAt: 1,
  updatedAt: 1,
  ...over
})

function ports(over: Partial<RestoredPaneStartPorts> = {}) {
  let bound: string | null | undefined = OWN
  const live = new Set<string>()
  const start = vi.fn(async () => {
    bound = 'pty-new'
    live.add('pty-new')
    return 'pty-new'
  })
  return {
    live,
    setBound: (id: string | null | undefined) => {
      bound = id
    },
    ports: {
      boundPtyId: () => bound,
      isLive: (ptyId: string) => live.has(ptyId),
      sleepingRecord: () => null,
      start,
      ...over
    } satisfies RestoredPaneStartPorts,
    start
  }
}

describe('restoredPaneStartPlan', () => {
  it('restores from its own stored terminal and resumes its local agent', () => {
    expect(restoredPaneStartPlan(PANE, OWN, record())).toEqual({
      sessionId: OWN,
      resume: { agent: 'codex', providerSession: { key: 'session_id', id: 's-1' } }
    })
  })

  it("never restores from another workspace's terminal, nor resumes another host's agent", () => {
    expect(
      restoredPaneStartPlan(PANE, 'repo-2::/other@@x', record({ connectionId: 'ssh-1' }))
    ).toEqual({})
  })
})

describe('RestoredPaneStarter', () => {
  it('starts a pane with no live terminal once for concurrent triggers, all bound to it', async () => {
    const { ports: p, start } = ports()
    const starter = new RestoredPaneStarter(p)

    const results = await Promise.all([
      starter.ensureStarted(PANE),
      starter.ensureStarted(PANE),
      starter.ensureStarted(PANE)
    ])

    expect(start).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledWith(PANE, { sessionId: OWN })
    expect(results).toEqual(['pty-new', 'pty-new', 'pty-new'])
  })

  it('starts nothing for a pane already live, or one main no longer holds', async () => {
    const live = ports()
    live.live.add(OWN)
    expect(await new RestoredPaneStarter(live.ports).ensureStarted(PANE)).toBe(OWN)
    expect(live.start).not.toHaveBeenCalled()

    const gone = ports()
    gone.setBound(null)
    expect(await new RestoredPaneStarter(gone.ports).ensureStarted(PANE)).toBeNull()
    expect(gone.start).not.toHaveBeenCalled()
  })

  it('resolves to the terminal another starter bound when its own start lost the race', async () => {
    const harness = ports()
    harness.start.mockImplementationOnce(async () => {
      harness.setBound('pty-window')
      harness.live.add('pty-window')
      throw new Error('terminal_pane_owner_unknown')
    })

    expect(await new RestoredPaneStarter(harness.ports).ensureStarted(PANE)).toBe('pty-window')
  })

  it('reports a failed start that left the pane without a live terminal', async () => {
    const harness = ports()
    harness.start.mockRejectedValueOnce(new Error('shell not found'))

    await expect(new RestoredPaneStarter(harness.ports).ensureStarted(PANE)).rejects.toThrow(
      'shell not found'
    )
  })
})
