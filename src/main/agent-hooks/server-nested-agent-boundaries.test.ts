import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'
import { PANE } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

class ClockedHookServer extends AgentHookServer {
  advanceConnectionClock(at: number): void {
    this.connectionTimestampWatermarkById.set('conn-1', at)
  }
}

const route = { paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1' }

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('nested provider ownership boundaries', () => {
  it('uses the retained connection clock to allow a stale provider replacement after rollback', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const server = new ClockedHookServer()
    server.ingestRemote(
      { ...route, payload: { state: 'working', prompt: 'Old work', agentType: 'claude' } },
      'conn-1'
    )
    const future = 1_000 + AGENT_STATUS_STALE_AFTER_MS + 100
    server.advanceConnectionClock(future)
    vi.setSystemTime(500)
    server.ingestRemote(
      { ...route, payload: { state: 'working', prompt: 'New work', agentType: 'codex' } },
      'conn-1'
    )
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      agentType: 'codex',
      prompt: 'New work',
      receivedAt: future + 1
    })
  })

  it('keeps nested Pi identity-only metadata off an active owner and permits it after completion', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const server = new AgentHookServer()
    server.ingestRemote(
      {
        ...route,
        payload: { state: 'working', prompt: 'Parent work', agentType: 'claude' },
        providerSession: { key: 'session_id', id: 'claude-parent' }
      },
      'conn-1'
    )
    const before = server.getStatusSnapshot()
    const pi = {
      ...route,
      providerSessionOnly: true,
      providerSession: {
        key: 'session_id' as const,
        id: 'pi-child',
        transcriptPath: '/tmp/pi-child.jsonl'
      },
      payload: { state: 'done' as const, prompt: '', agentType: 'pi' as const }
    }
    server.ingestRemote(pi, 'conn-1')
    expect(server.getStatusSnapshot()).toEqual(before)
    server.ingestRemote(
      { ...route, payload: { state: 'done', prompt: 'Parent work', agentType: 'claude' } },
      'conn-1'
    )
    server.ingestRemote(pi, 'conn-1')
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      agentType: 'pi',
      providerSessionOnly: true,
      providerSession: { id: 'pi-child' }
    })
  })
})
