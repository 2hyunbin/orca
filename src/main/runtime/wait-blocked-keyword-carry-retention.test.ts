import { describe, expect, it, vi } from 'vitest'
import * as ownership from '../../shared/own-retained-string'
import { TerminalWaitBlockedChecks } from './terminal/wait/terminal-wait-blocked-checks'
import * as checkState from './wait-blocked-check-state'
import { WAIT_BLOCKED_KEYWORD_CARRY_CHARS } from './orca-runtime-postlude'

function createScheduleHost() {
  const state = checkState.createWaitBlockedCheckState()
  const createState = vi.spyOn(checkState, 'createWaitBlockedCheckState').mockReturnValue(state)
  const checks = new TerminalWaitBlockedChecks({
    getPty: () => undefined,
    recordAgentPromptPermissionObservation: () => {}
  })
  return { checks, state, restore: () => createState.mockRestore() }
}

describe('wait-blocked keyword carry storage', () => {
  it('owns the carry so it stops pinning the lowercased chunk window', () => {
    const own = vi.spyOn(ownership, 'ownRetainedString')
    const host = createScheduleHost()
    try {
      const chunk = `${'Building Project '.repeat(4096)}tail-marker-text`
      host.checks.scheduleWaitBlockedCheck('pty-1', chunk, 0)

      const carry = host.state.keywordCarry
      expect(carry).toBe(chunk.toLowerCase().slice(-WAIT_BLOCKED_KEYWORD_CARRY_CHARS))
      expect(carry).toHaveLength(WAIT_BLOCKED_KEYWORD_CARRY_CHARS)
      expect(own).toHaveBeenCalledTimes(1)
      expect(own).toHaveBeenLastCalledWith(carry)
    } finally {
      host.restore()
      own.mockRestore()
    }
  })

  it('keeps the carry joined to the next chunk so split keywords still match', () => {
    const host = createScheduleHost()
    try {
      host.checks.scheduleWaitBlockedCheck('pty-2', `${'x'.repeat(8 * 1024)}press`, 0)
      const carry = host.state.keywordCarry
      expect(carry?.endsWith('press')).toBe(true)
      host.checks.scheduleWaitBlockedCheck('pty-2', ' ENTER to continue', 1)
      expect(host.state.keywordCarry).toBe(
        `${carry} enter to continue`.slice(-WAIT_BLOCKED_KEYWORD_CARRY_CHARS)
      )
    } finally {
      host.restore()
    }
  })
})
