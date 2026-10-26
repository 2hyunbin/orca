import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WslRunningDistrosRead } from '../wsl-background-distro-gate'
import {
  _resetRunningWslDistroCacheForTests,
  resolveRunningWslDistros
} from '../wsl-running-distro-cache'
import { isWslBridgeDistroLost } from './daemon-wsl-bridge-exit'

afterEach(() => {
  _resetRunningWslDistroCacheForTests()
})

describe('isWslBridgeDistroLost', () => {
  it('spawns one running-list probe for many panes a terminate exits at once', async () => {
    let answer: (distros: string[]) => void = () => {}
    const probe = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          answer = resolve
        })
    )
    // The production reader's shape: the shared, coalesced probe, confirmed or unavailable.
    const readRunning = async (): Promise<WslRunningDistrosRead> => ({
      status: 'confirmed',
      distros: await resolveRunningWslDistros(probe, { requireConfirmed: true })
    })

    const checks = [1, 2, 3].map(() => isWslBridgeDistroLost('Ubuntu', readRunning))
    answer(['Debian'])

    await expect(Promise.all(checks)).resolves.toEqual([true, true, true])
    expect(probe).toHaveBeenCalledOnce()
  })

  it('matches the distro case-insensitively, and a running distro is not lost', async () => {
    await expect(
      isWslBridgeDistroLost('ubuntu', async () => ({ status: 'confirmed', distros: ['Ubuntu'] }))
    ).resolves.toBe(false)
  })

  it('treats a hung check as unanswered, so the exit stays an exit', async () => {
    await expect(isWslBridgeDistroLost('Ubuntu', () => new Promise(() => {}), 10)).resolves.toBe(
      false
    )
  })

  it('treats a failed check as unanswered', async () => {
    await expect(
      isWslBridgeDistroLost('Ubuntu', async () => {
        throw new Error('wsl.exe missing')
      })
    ).resolves.toBe(false)
  })
})
