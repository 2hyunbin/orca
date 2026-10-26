import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusState, ParsedAgentStatusPayload } from '../../shared/agent-status-types'
import type { AgentStatusParentInput } from '../../shared/agent-status-store-parent'
import type { AgentStatusExecutionScope } from '../../shared/agent-status-subject'
import {
  admitLegacyAgentStatus,
  clearLegacyAgentStatuses
} from '../../shared/agent-hook-listener/listener-state'
import { AGENT_STATUS_2A_CURRENT_PRODUCER_MODE } from '../../shared/agent-status-legacy-adapter'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import * as statusIdentity from './server/server-status-identity'
import * as structuredRows from './server/server-structured-status-row'
import { AgentHookServer } from './server'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const scope: AgentStatusExecutionScope = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace',
  workspaceKind: 'git-worktree'
}

class ActivityServer extends AgentHookServer {
  putLegacy(entry: AgentHookEventPayload): void {
    admitLegacyAgentStatus(
      this._getStateForTests(),
      'main-status-update',
      entry,
      AGENT_STATUS_2A_CURRENT_PRODUCER_MODE
    )
  }

  putCanonical(paneKey: string, state?: AgentStatusState): void {
    const parent: AgentStatusParentInput = {
      subject: { ...scope, kind: 'pty', paneKey },
      ...(state
        ? {
            status: {
              paneKey,
              worktreeId: scope.workspaceId,
              connectionId: null,
              receivedAt: 1,
              stateStartedAt: 1,
              state,
              prompt: ''
            }
          }
        : {})
    }
    expect(this.canonicalStatusStore.applyMutation({ parent })).not.toBeNull()
  }
}

afterEach(() => vi.restoreAllMocks())

describe('working-agent admission predicate', () => {
  it('follows current legacy and canonical states without retaining a separate activity cache', () => {
    const server = new ActivityServer()
    expect(server.hasWorkingAgent()).toBe(false)
    server.putLegacy({
      paneKey: 'legacy',
      connectionId: null,
      payload: { state: 'working', prompt: '' }
    })
    expect(server.hasWorkingAgent()).toBe(true)
    server.putLegacy({
      paneKey: 'legacy',
      connectionId: null,
      payload: { state: 'done', prompt: '' }
    })
    expect(server.hasWorkingAgent()).toBe(false)
    server.putCanonical('canonical', 'working')
    expect(server.hasWorkingAgent()).toBe(true)
    server.putCanonical('canonical', 'waiting')
    expect(server.hasWorkingAgent()).toBe(false)
    clearLegacyAgentStatuses(server._getStateForTests())
    server.putCanonical('canonical')
    expect(server.hasWorkingAgent()).toBe(false)
  })

  it('excludes tmux inner observations just as the published activity snapshot does', () => {
    const server = new ActivityServer()
    server.putCanonical('tmux-inner:observed-pane', 'working')
    server.putCanonical('outer-pane', 'done')
    expect(server.getStatusSnapshot().some((row) => row.state === 'working')).toBe(false)
    expect(server.hasWorkingAgent()).toBe(false)
    server.putCanonical('outer-pane', 'working')
    expect(server.hasWorkingAgent()).toBe(true)
  })

  it.each([1000, 10000])('avoids sorting and IPC projections across %i legacy rows', (count) => {
    const server = new ActivityServer()
    let visited = 0
    let firstWorking = false
    for (let index = 0; index < count; index += 1) {
      server.putLegacy({
        paneKey: String(index),
        connectionId: null,
        get payload(): ParsedAgentStatusPayload {
          visited += 1
          return { state: firstWorking && index === 0 ? 'working' : 'done', prompt: '' }
        }
      })
    }
    server.putCanonical('canonical', 'done')
    const ipcProjection = vi.spyOn(statusIdentity, 'toAgentStatusIpcPayload')
    const legacyProjection = vi.spyOn(structuredRows, 'structuredStatusLegacyEvent')
    const snapshot = vi.spyOn(server, 'getStatusSnapshot')
    const sort = vi.spyOn(Array.prototype, 'sort')
    const baseline = server.getStatusSnapshot().some((row) => row.state === 'working')
    const baselineProjections = ipcProjection.mock.calls.length
    const baselineSorts = sort.mock.calls.length
    ipcProjection.mockClear()
    legacyProjection.mockClear()
    snapshot.mockClear()
    sort.mockClear()
    visited = 0
    const idle = server.hasWorkingAgent()
    const idleVisits = visited
    firstWorking = true
    visited = 0
    const busy = server.hasWorkingAgent()
    const busyVisits = visited
    const sortCalls = sort.mock.calls.length
    sort.mockRestore()
    expect(baseline).toBe(false)
    expect(baselineProjections).toBe(count + 1)
    expect(baselineSorts).toBe(1)
    expect(idle).toBe(false)
    expect(idleVisits).toBe(count)
    expect(busy).toBe(true)
    expect(busyVisits).toBe(1)
    expect(ipcProjection).not.toHaveBeenCalled()
    expect(legacyProjection).not.toHaveBeenCalled()
    expect(snapshot).not.toHaveBeenCalled()
    expect(sortCalls).toBe(0)
  })
})
