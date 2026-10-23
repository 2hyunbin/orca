import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { RuntimeTerminalSend } from '../../shared/runtime-terminal-send-contract'
import { interruptWorkingAgent } from './terminal-agent-interrupt'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

function row(state: AgentStatusIpcPayload['state']): AgentStatusIpcPayload {
  return {
    state,
    prompt: '',
    agentType: 'codex',
    paneKey: PANE,
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 1
  }
}

function harness() {
  const state = { row: row('working') as AgentStatusIpcPayload | null, incarnation: 'inc-1' }
  const keys: string[] = []
  const runtime = {
    getTerminalHandleForPaneKey: (paneKey: string) => (paneKey === PANE ? 'term-1' : null),
    getTerminalPromptRequestBinding: () => ({
      ptyId: 'pty-1',
      processIncarnation: state.incarnation,
      generation: 1
    }),
    sendTerminal: vi.fn(
      async (
        handle: string,
        action: { text?: string; enter?: boolean },
        options: { beforeWrite?: (ptyId: string) => void | Promise<void> }
      ): Promise<RuntimeTerminalSend> => {
        await options.beforeWrite?.('pty-1')
        expect(action.enter).toBe(false)
        keys.push(action.text ?? '')
        return { handle, accepted: true, bytesWritten: 1, writeSettlement: { outcome: 'accepted' } }
      }
    )
  }
  const interrupt = (beforeWrite?: () => Promise<void>, paneKey = PANE) =>
    interruptWorkingAgent(runtime, () => state.row, paneKey, {
      beforeWrite,
      signal: new AbortController().signal
    })
  return { state, keys, interrupt }
}

describe('interruptWorkingAgent', () => {
  it('writes one Escape, without Enter, while the hook row says working', async () => {
    const h = harness()
    await expect(h.interrupt()).resolves.toEqual({ outcome: 'accepted' })
    expect(h.keys).toEqual(['\x1b'])
  })

  it('types nothing into an idle or waiting agent, or a pane with no terminal', async () => {
    const h = harness()
    for (const state of ['done', 'waiting', 'blocked'] as const) {
      h.state.row = row(state)
      await expect(h.interrupt()).resolves.toEqual({
        outcome: 'refused',
        reason: 'agent_not_working'
      })
    }
    h.state.row = row('working')
    await expect(h.interrupt(undefined, 'tab-9:other')).resolves.toEqual({
      outcome: 'refused',
      reason: 'agent_not_reachable'
    })
    expect(h.keys).toEqual([])
  })

  it('re-checks last: a turn that ended, or a new process, gets no key', async () => {
    const h = harness()
    await expect(
      h.interrupt(async () => {
        h.state.row = row('done')
      })
    ).resolves.toEqual({ outcome: 'refused', reason: 'agent_not_working' })
    h.state.row = row('working')
    await expect(
      h.interrupt(async () => {
        h.state.incarnation = 'inc-2'
      })
    ).resolves.toEqual({ outcome: 'refused', reason: 'agent_not_reachable' })
    expect(h.keys).toEqual([])
  })
})
