import { describe, expect, it, vi } from 'vitest'
import {
  stopWslMoveHostAutomations,
  wslMoveAutomationsToTurnOffOnHost
} from './wsl-move-undo-host-automations'

const moveOf = (...ids: string[]) => ({
  manifest: { payload: { dormantState: { automations: ids.map((id) => ({ id })) } } }
})

describe("undo's host automation step", () => {
  it("picks only this move's automations, and only those on here", () => {
    const local = [
      { id: 'moved-on', enabled: true },
      { id: 'moved-off', enabled: false },
      // Another move's automation (partial undo leaves it to its own move).
      { id: 'other-move-on', enabled: true }
    ]
    expect(wslMoveAutomationsToTurnOffOnHost(moveOf('moved-on', 'moved-off'), local)).toEqual([
      'moved-on'
    ])
    expect(wslMoveAutomationsToTurnOffOnHost({ manifest: { payload: {} } }, local)).toEqual([])
  })

  it('reports a refusal as failed and anything else as unreachable', async () => {
    expect(await stopWslMoveHostAutomations(['a'], async () => {})).toBe('stopped')
    expect(
      await stopWslMoveHostAutomations(['a'], async () => {
        throw new Error('wsl_move_automation_disable_failed:busy')
      })
    ).toBe('failed')
    expect(
      await stopWslMoveHostAutomations(['a'], async () => {
        throw new Error('Ubuntu was stopped')
      })
    ).toBe('unreachable')
    const disable = vi.fn(async () => {})
    expect(await stopWslMoveHostAutomations([], disable)).toBe('stopped')
    expect(disable).not.toHaveBeenCalled()
  })
})
