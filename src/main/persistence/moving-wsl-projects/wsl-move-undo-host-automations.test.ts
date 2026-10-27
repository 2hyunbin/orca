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
  wslMoveAutomationsToTurnOffOnHost
} from './wsl-move-undo-host-automations'

const moveOf = (...ids: string[]) => ({
  manifest: { payload: { dormantState: { automations: ids.map((id) => ({ id })) } } }
})
const noLeftOff = () => {}

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
    const host = (disable: () => Promise<string[]>) => ({ disable, restore, leftOff: noLeftOff })
    const refusing = async (): Promise<string[]> => {
      throw new Error('wsl_move_automation_disable_failed:busy')
    }
    const unreachable = async (): Promise<string[]> => {
      throw new Error('Ubuntu was stopped')
    }
    expect((await stopWslMoveHostAutomations(['a'], host(refusing))).outcome).toBe('failed')
    expect((await stopWslMoveHostAutomations(['a'], host(unreachable))).outcome).toBe('unreachable')
    const disable = vi.fn(async () => [])
    expect((await stopWslMoveHostAutomations([], host(disable))).outcome).toBe('stopped')
    expect(disable).not.toHaveBeenCalled()
  })

  it('rolls back only what this attempt turned off, and records what it cannot', async () => {
    const restore = vi.fn(async () => {})
    const leftOff = vi.fn()
    const stopped = await stopWslMoveHostAutomations(['a', 'b'], {
      // `b` was already off on the host: not this attempt's to turn back on.
      disable: async () => ['a'],
      restore,
      leftOff
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
