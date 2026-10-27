import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  profile: vi.fn(),
  route: vi.fn(),
  bind: vi.fn(),
  clear: vi.fn()
}))
vi.mock('./browser-client-route-cookie-import', () => ({ bindRoutePartition: mocks.bind }))
vi.mock('./browser-session-registry', () => ({
  browserSessionRegistry: { getProfile: mocks.profile }
}))
vi.mock('./paired-runtime-browser-client-host-runtime', () => ({
  getPairedRuntimeBrowserClientRouteIdentity: mocks.route
}))
vi.mock('./cookies/browser-google-cookie-clear', () => ({
  clearGoogleCookiesFromPartition: mocks.clear
}))
import {
  googleCookieClearLocalTarget,
  clearGoogleCookiesForLocalTarget
} from './browser-google-cookie-clear-target'

describe('frozen Google cookie destination', () => {
  beforeEach(() => {
    mocks.profile.mockReturnValue({
      id: 'secondary',
      partition: 'persist:secondary',
      source: { browserFamily: 'chrome' }
    })
    mocks.route.mockReturnValue(null)
    mocks.bind.mockReturnValue('persist:route')
    mocks.clear.mockResolvedValue('cleared')
    vi.clearAllMocks()
  })
  it('clears a non-default local profile without changing its source', async () => {
    const target = googleCookieClearLocalTarget('secondary', null)!
    expect(target.partition).toBe('persist:secondary')
    await clearGoogleCookiesForLocalTarget(target)
    expect(mocks.clear).toHaveBeenCalledWith('persist:secondary', expect.any(Function))
    expect(mocks.profile().source).toEqual({ browserFamily: 'chrome' })
  })
  it('uses the same route binding resolver as import', async () => {
    const identity = { authorityConnectionIdentity: 'first' }
    mocks.route.mockReturnValue(identity)
    const target = googleCookieClearLocalTarget('secondary', 'server')!
    expect(mocks.bind).toHaveBeenCalledWith(identity, 'secondary')
    await clearGoogleCookiesForLocalTarget(target)
    expect(mocks.clear).toHaveBeenCalledWith('persist:route', expect.any(Function))
  })
  it.each(['disconnect', 're-pair'])(
    'rejects %s even when a new route reuses the partition',
    (change) => {
      mocks.route.mockReturnValue({ authorityConnectionIdentity: 'first' })
      const target = googleCookieClearLocalTarget('secondary', 'server')!
      mocks.route.mockReturnValue(
        change === 'disconnect' ? null : { authorityConnectionIdentity: 'second' }
      )
      expect(() => clearGoogleCookiesForLocalTarget(target)).toThrow('connection changed')
      expect(mocks.clear).not.toHaveBeenCalled()
    }
  )
  it('never accepts an arbitrary renderer partition', () => {
    const target = googleCookieClearLocalTarget('secondary', null)!
    expect(() =>
      clearGoogleCookiesForLocalTarget({ ...target, partition: 'persist:another' })
    ).toThrow()
    expect(mocks.clear).not.toHaveBeenCalled()
  })
})
