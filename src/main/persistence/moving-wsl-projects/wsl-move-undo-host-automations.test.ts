import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wslMoveCutoverFixture } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { listWslMoveCutovers } from './wsl-move-cutover-journal'
import { listUnfinishedWslMoves } from './wsl-move-host-automations-rewrite'
import { resetWslMoveDesktopRewriteStoresForTests } from './wsl-move-desktop-rewrite-stores'
import {
  recordWslMoveHostAutomationsLeftOff,
  retryWslMoveHostAutomationsLeftOff,
  stopWslMoveHostAutomations,
  wslMoveLocalAutomationStateUpdates,
  wslMoveMovedAutomationIds
} from './wsl-move-undo-host-automations'

const moveOf = (...ids: string[]) => ({
  manifest: { payload: { dormantState: { automations: ids.map((id) => ({ id })) } } }
})
const noLeftOff = () => {}

describe("undo's host automation step", () => {
  it("reads every one of this move's automations, and only this move's", () => {
    expect(wslMoveMovedAutomationIds(moveOf('a', 'b'))).toEqual(['a', 'b'])
    expect(wslMoveMovedAutomationIds({ manifest: { payload: {} } })).toEqual([])
  })

  // d3a: undo kept the pre-move state and dropped what the user chose on the host since.
  it("gives the copies here the host's state, the user's latest choice", () => {
    const local = [
      { id: 'off-on-host', enabled: true },
      { id: 'on-on-host', enabled: false },
      { id: 'same', enabled: true },
      { id: 'not-moved', enabled: true }
    ]
    expect(
      wslMoveLocalAutomationStateUpdates(local, {
        'off-on-host': false,
        'on-on-host': true,
        same: true
      })
    ).toEqual([
      { id: 'off-on-host', enabled: false },
      { id: 'on-on-host', enabled: true }
    ])
  })

  it('reports a refusal as failed and anything else as unreachable', async () => {
    const restore = vi.fn(async () => {})
    type TurnedOff = { turnedOff: string[]; hostEnabled: Record<string, boolean> }
    const host = (disable: () => Promise<TurnedOff>) => ({
      disable,
      restore,
      leftOff: noLeftOff,
      applyHere: () => {}
    })
    const refusing = async (): Promise<TurnedOff> => {
      throw new Error('wsl_move_automation_disable_failed:busy')
    }
    const unreachable = async (): Promise<TurnedOff> => {
      throw new Error('Ubuntu was stopped')
    }
    expect((await stopWslMoveHostAutomations(['a'], host(refusing))).outcome).toBe('failed')
    expect((await stopWslMoveHostAutomations(['a'], host(unreachable))).outcome).toBe('unreachable')
    const disable = vi.fn(async () => ({ turnedOff: [], hostEnabled: {} }))
    expect((await stopWslMoveHostAutomations([], host(disable))).outcome).toBe('stopped')
    expect(disable).not.toHaveBeenCalled()
  })

  it('rolls back only what this attempt turned off, and records what it cannot', async () => {
    const restore = vi.fn(async () => {})
    const leftOff = vi.fn()
    const stopped = await stopWslMoveHostAutomations(['a', 'b'], {
      // `b` was already off on the host: not this attempt's to turn back on.
      disable: async () => ({ turnedOff: ['a'], hostEnabled: { a: true, b: false } }),
      restore,
      leftOff,
      applyHere: () => {}
    })
    if (stopped.outcome !== 'stopped') {
      throw new Error('expected stopped')
    }
    await stopped.restore()
    expect(restore).toHaveBeenCalledWith(['a'])
    expect(leftOff).not.toHaveBeenCalled()

    restore.mockRejectedValueOnce(new Error('host gone'))
    await stopped.restore()
    expect(leftOff).toHaveBeenCalledWith(['a'])
  })
})

describe('automations a refused undo left off on the host', () => {
  let userDataPath: string
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-undo-automations-'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    resetWslMoveDesktopRewriteStoresForTests()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('are shown in the unfinished-move notice and retried until the host turns them on', async () => {
    seedWslMoveCutover(userDataPath, wslMoveCutoverFixture('move-1', 'retained'))
    recordWslMoveHostAutomationsLeftOff(userDataPath, 'move-1', ['b', 'a'])
    expect(listUnfinishedWslMoves(userDataPath)).toEqual([
      { migrationId: 'move-1', distro: 'Ubuntu', automationsPending: ['a', 'b'] }
    ])

    const failing = vi.fn(async () => {
      throw new Error('unreachable')
    })
    expect(await retryWslMoveHostAutomationsLeftOff(userDataPath, failing)).toBe(true)
    expect(listWslMoveCutovers(userDataPath)[0]?.hostAutomationsLeftOff).toEqual(['a', 'b'])

    const turnedOn = vi.fn(async () => {})
    expect(await retryWslMoveHostAutomationsLeftOff(userDataPath, turnedOn)).toBe(false)
    expect(turnedOn).toHaveBeenCalledWith('wsl:Ubuntu', ['a', 'b'])
    expect(listWslMoveCutovers(userDataPath)[0]?.hostAutomationsLeftOff).toBeUndefined()
    expect(listUnfinishedWslMoves(userDataPath)).toEqual([])
  })
})
