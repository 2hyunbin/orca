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
    const restore = vi.fn(async () => {})
    const stopped = await stopWslMoveHostAutomations(['a', 'b'], {
      disable: async () => ['a'],
      restore
    })
    expect(stopped.outcome).toBe('stopped')
    // Restore turns back on only what the disable turned off.
    if (stopped.outcome === 'stopped') {
      await stopped.restore()
    }
    expect(restore).toHaveBeenCalledWith(['a'])
    const refusing = async (): Promise<string[]> => {
      throw new Error('wsl_move_automation_disable_failed:busy')
    }
    expect((await stopWslMoveHostAutomations(['a'], { disable: refusing, restore })).outcome).toBe(
      'failed'
    )
    const unreachable = async (): Promise<string[]> => {
      throw new Error('Ubuntu was stopped')
    }
    expect(
      (await stopWslMoveHostAutomations(['a'], { disable: unreachable, restore })).outcome
    ).toBe('unreachable')
    const disable = vi.fn(async () => [])
    expect((await stopWslMoveHostAutomations([], { disable, restore })).outcome).toBe('stopped')
    expect(disable).not.toHaveBeenCalled()
  })
})
