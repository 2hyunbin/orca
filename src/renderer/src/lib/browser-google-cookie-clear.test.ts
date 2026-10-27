import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  state: {},
  target: vi.fn(),
  clear: vi.fn(),
  rpc: vi.fn(),
  success: vi.fn(),
  error: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error } }))
import { offerGoogleCookieClear } from './browser-google-cookie-clear'

function state(remote = false, capable = false) {
  return {
    settings: {},
    browserSessionHostIdOverride: remote ? 'runtime:server' : 'local',
    browserSessionProfilesByHostId: {},
    browserSessionProfiles: [{ id: 'profile', label: 'Work' }],
    runtimeEnvironments: [{ id: 'server', pairingRevision: 7, createdAt: 1 }],
    runtimeStatusByEnvironmentId: new Map([
      [
        'server',
        {
          status: {
            runtimeId: 'runtime-first',
            capabilities: capable ? ['browser.google-cookie-clear.v1'] : []
          }
        }
      ]
    ])
  }
}
const local = {
  profileId: 'profile',
  environmentId: null,
  partition: 'persist:work',
  routeIdentity: null
}

async function offer(confirm = vi.fn(async () => true)) {
  let finished = Promise.resolve()
  const action = await offerGoogleCookieClear('profile', 'Work', confirm, (run) => {
    finished = run()
  })
  return { action, confirm, finish: () => finished }
}

describe('Google cookie clear offers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state = state()
    mocks.target.mockResolvedValue(local)
    mocks.clear.mockResolvedValue('cleared')
    mocks.rpc.mockResolvedValue('cleared')
    vi.stubGlobal('window', {
      api: {
        browser: {
          sessionGoogleCookieClearTarget: mocks.target,
          sessionClearGoogleCookies: mocks.clear
        }
      }
    })
  })
  it('confirms a frozen target and never follows a Settings host switch', async () => {
    const { action, confirm, finish } = await offer()
    mocks.state = state(true, true)
    action?.onClick()
    await finish()
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Clear Google cookies from Work?' })
    )
    expect(mocks.clear).toHaveBeenCalledWith(local)
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.success).toHaveBeenCalledWith('Google cookies cleared from Work.')
  })
  it('cancel performs no mutation', async () => {
    const { action, finish } = await offer(vi.fn(async () => false))
    action?.onClick()
    await finish()
    expect(mocks.clear).not.toHaveBeenCalled()
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it('old remote servers hide the action, while their client-route jar stays usable', async () => {
    mocks.state = state(true)
    mocks.target.mockResolvedValueOnce(null)
    expect((await offer()).action).toBeUndefined()
    mocks.target.mockResolvedValueOnce({
      ...local,
      environmentId: 'server',
      routeIdentity: 'first'
    })
    expect((await offer()).action?.executionMachine).toBe('client')
  })
  it('pins the remote method to the offered pairing and runtime, without whole-jar fallback', async () => {
    mocks.state = state(true, true)
    mocks.target.mockResolvedValue(null)
    const { action, finish } = await offer()
    mocks.state = state()
    mocks.rpc.mockRejectedValueOnce(new Error('pairing changed'))
    action?.onClick()
    await finish()
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith(
      { kind: 'environment', environmentId: 'server' },
      'browser.profileClearGoogleCookies',
      { profileId: 'profile' },
      { expectedEnvironmentPairingRevision: 7, expectedEnvironmentRuntimeId: 'runtime-first' }
    )
    expect(mocks.clear).not.toHaveBeenCalled()
    expect(mocks.error).toHaveBeenCalledWith("Couldn't check Work's Google cookies. Try again.")
  })
  it.each([
    ['empty', 'No Google cookies to clear in Work.'],
    ['remaining', "Some Google cookies couldn't be removed from Work. Try again."],
    ['unverified', "Couldn't check Work's Google cookies. Try again."]
  ])('reports %s truthfully', async (result, message) => {
    mocks.clear.mockResolvedValue(result)
    const { action, finish } = await offer()
    action?.onClick()
    await finish()
    expect(result === 'empty' ? mocks.success : mocks.error).toHaveBeenCalledWith(message)
  })
})
