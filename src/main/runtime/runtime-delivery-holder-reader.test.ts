import { describe, expect, it } from 'vitest'
import { terminalHolderTurnEnd } from './runtime-delivery-holder-reader'
import type { TerminalHookRow } from './runtime-terminal-hook-row'

const holder = {
  kind: 'terminal' as const,
  handle: 'term_coordinator',
  processIncarnation: 'pty:1',
  agentSessionId: 'conversation-1',
  agentTurnStartedAt: 100
}

function row(conversation: string, turnStartedAt: number, done?: 'cancellation'): TerminalHookRow {
  return {
    paneKey: 'pane',
    agentType: 'codex',
    providerSession: { key: 'session_id', id: conversation },
    connectionId: null,
    receivedAt: turnStartedAt,
    turnStartedAt,
    mainAgent: done
      ? { state: 'done', outcome: done, stateStartedAt: turnStartedAt }
      : { state: 'working', stateStartedAt: turnStartedAt }
  }
}

describe('a terminal holder of fetched mail', () => {
  // The agent was quit and started again in the same shell: the PTY is the same, the turn is gone.
  it('counts a new agent conversation in the same shell as a cut turn', () => {
    expect(
      terminalHolderTurnEnd(holder, { incarnation: 'pty:1', row: row('conversation-2', 300) })
    ).toBe('cut')
    expect(
      terminalHolderTurnEnd(holder, { incarnation: 'pty:1', row: row('conversation-1', 100) })
    ).toBe('running')
    expect(
      terminalHolderTurnEnd(holder, { incarnation: 'pty:1', row: row('conversation-1', 300) })
    ).toBe('ended')
    expect(
      terminalHolderTurnEnd(holder, {
        incarnation: 'pty:1',
        row: row('conversation-1', 100, 'cancellation')
      })
    ).toBe('stopped')
  })
})
