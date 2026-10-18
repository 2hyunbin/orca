import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted((): { state: { orcaProfileSignInLink: string | null } } => ({
  state: { orcaProfileSignInLink: null }
}))

vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => ({ fetchOrcaProfileAuthStatus: vi.fn() }),
    setState: (partial: { orcaProfileSignInLink: string | null }) => {
      Object.assign(mocks.state, partial)
    }
  }
}))

import { registerOrcaProfileAuthIpcBridge } from './orca-profile-auth-ipc-bridge'

describe('registerOrcaProfileAuthIpcBridge sign-in link', () => {
  let emitLink: (link: string | null) => void
  let resolveSnapshot: ((link: string | null) => void) | undefined

  async function snapshotRequested(): Promise<(link: string | null) => void> {
    await vi.waitFor(() => expect(resolveSnapshot).toBeDefined())
    return resolveSnapshot ?? (() => {})
  }

  beforeEach(() => {
    mocks.state.orcaProfileSignInLink = null
    resolveSnapshot = undefined
    vi.stubGlobal('window', {
      api: {
        orcaProfiles: {
          onAuthStatusChanged: () => () => {},
          onSignInLinkChanged: (callback: (link: string | null) => void) => {
            emitLink = callback
            return () => {}
          },
          pendingSignInLink: () =>
            new Promise<string | null>((resolve) => {
              resolveSnapshot = resolve
            })
        }
      }
    })
  })

  it('adopts the link of a sign-in already waiting when the window loads', async () => {
    registerOrcaProfileAuthIpcBridge([])
    const resolveCurrent = await snapshotRequested()
    resolveCurrent('https://login.example/authorize?state=a')
    await vi.waitFor(() =>
      expect(mocks.state.orcaProfileSignInLink).toBe('https://login.example/authorize?state=a')
    )
  })

  it('does not let a stale snapshot overwrite a newer change', async () => {
    registerOrcaProfileAuthIpcBridge([])
    const resolveStale = await snapshotRequested()
    emitLink(null)
    resolveStale('https://login.example/authorize?state=old')
    await Promise.resolve()
    await Promise.resolve()
    expect(mocks.state.orcaProfileSignInLink).toBeNull()
  })
})
