import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { getDefaultSettings } from '../../shared/constants'

const { prepareHooks, resolveHome, listHomes, holdsOwnHooks } = vi.hoisted(() => ({
  holdsOwnHooks: vi.fn((_home: string) => false),
  prepareHooks: vi.fn(
    async (
      _home: string | null,
      _target: unknown,
      _isHooksEnabled: () => boolean,
      _launchesCodex: boolean
    ) => {}
  ),
  resolveHome: vi.fn((candidate: string | undefined): string | null =>
    candidate === '/home/u/.local/share/orca/codex-accounts/a1/home' ? candidate : null
  ),
  listHomes: vi.fn(() => ['/home/u/.local/share/orca/codex-accounts/a1/home'])
}))

vi.mock('../codex/codex-launch-home-hooks', () => ({
  prepareCodexLaunchHomeHooks: prepareHooks
}))
vi.mock('../codex/codex-state-db-backfill-recovery', () => ({
  stopCodexStateDbBackfillRecoveries: vi.fn(async () => {})
}))
vi.mock('../codex/codex-runtime-home-user-hook-loss', () => ({
  runtimeHomeHasUnmirroredUserHooks: holdsOwnHooks
}))
vi.mock('../codex-accounts/guest-codex-account-homes', () => ({
  resolveGuestCodexAccountHome: resolveHome,
  listGuestCodexAccountHomes: listHomes
}))

import { orcadCodexAccountHomes } from './orcad-codex-account-homes'

const noCleanup = (): void => {}
const ACCOUNT_HOME = '/home/u/.local/share/orca/codex-accounts/a1/home'

function settings(overrides: Partial<GlobalSettings>): GlobalSettings {
  return {
    ...getDefaultSettings('/home/u'),
    agentStatusHooksEnabled: true,
    ...overrides
  }
}

describe('orcadCodexAccountHomes', () => {
  beforeEach(() => {
    prepareHooks.mockClear()
    holdsOwnHooks.mockReturnValue(false)
  })

  it('puts the hook into a client-sent account home and launches on it', async () => {
    const homes = orcadCodexAccountHomes(() => settings({}), noCleanup)
    await expect(
      homes.selectLaunchHome(
        { runtime: 'host' },
        { CODEX_HOME: ACCOUNT_HOME },
        { launchesCodex: true }
      )
    ).resolves.toBe(ACCOUNT_HOME)
    expect(prepareHooks).toHaveBeenCalledWith(ACCOUNT_HOME, undefined, expect.any(Function), true)
  })

  it('reads the hook switch live, so turning hooks off takes the entry out', async () => {
    let current = settings({})
    const homes = orcadCodexAccountHomes(() => current, noCleanup)
    await homes.selectLaunchHome(undefined, { CODEX_HOME: ACCOUNT_HOME })
    const isEnabled = prepareHooks.mock.calls[0]?.[2]
    expect(isEnabled?.()).toBe(true)
    current = settings({ agentStatusHooksEnabled: false })
    expect(isEnabled?.()).toBe(false)
    expect(prepareHooks.mock.calls[0]?.[3]).toBe(false)
  })

  it('leaves a launch without an Orca account home alone', async () => {
    const homes = orcadCodexAccountHomes(() => settings({}), noCleanup)
    await expect(
      homes.selectLaunchHome(undefined, { CODEX_HOME: '/home/u/my-codex' })
    ).resolves.toBe(null)
    await expect(homes.selectLaunchHome(undefined, {})).resolves.toBe(null)
    await expect(homes.selectLaunchHome()).resolves.toBe(null)
    expect(prepareHooks).not.toHaveBeenCalled()
  })

  it('lists the account homes for session discovery', () => {
    expect(orcadCodexAccountHomes(() => settings({}), noCleanup).listSessionHomes()).toEqual([
      ACCOUNT_HOME
    ])
  })

  it('leaves a home that holds its own hooks untouched rather than drop one', async () => {
    holdsOwnHooks.mockReturnValue(true)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const homes = orcadCodexAccountHomes(() => settings({}), noCleanup)
    await expect(
      homes.selectLaunchHome(undefined, { CODEX_HOME: ACCOUNT_HOME }, { launchesCodex: true })
    ).resolves.toBe(ACCOUNT_HOME)
    await homes.selectLaunchHome(undefined, { CODEX_HOME: ACCOUNT_HOME })
    expect(prepareHooks).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
