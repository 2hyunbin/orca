import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { beginOrcaCloudPkceFlowMock, exchangeOrcaCloudAuthCodeMock, safeStorageMock } = vi.hoisted(
  () => ({
    beginOrcaCloudPkceFlowMock: vi.fn(),
    exchangeOrcaCloudAuthCodeMock: vi.fn(),
    safeStorageMock: {
      decryptString: vi.fn((value: Buffer) => value.toString('utf-8')),
      encryptString: vi.fn((value: string) => Buffer.from(value, 'utf-8')),
      isEncryptionAvailable: vi.fn(() => true)
    }
  })
)

let userDataPath = ''

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  },
  safeStorage: safeStorageMock
}))

vi.mock('./profile-cloud-pkce', () => ({
  beginOrcaCloudPkceFlow: beginOrcaCloudPkceFlowMock
}))

vi.mock('./profile-cloud-client', () => ({
  createOrcaCloudProfile: vi.fn(),
  exchangeOrcaCloudAuthCode: exchangeOrcaCloudAuthCodeMock,
  revokeOrcaCloudSession: vi.fn().mockResolvedValue(undefined),
  selectOrcaCloudOrg: vi.fn()
}))

import {
  connectCurrentOrcaProfile,
  getPendingOrcaCloudSignInLink,
  signOutCurrentOrcaProfile
} from './profile-cloud-service'

type PendingWait = {
  url: string
  answer: (code: string) => void
  fail: (error: Error) => void
}

// Each call reports its link the way the real flow does, then waits for the test to end it.
function queueBrowserWaits(): PendingWait[] {
  const waits: PendingWait[] = []
  beginOrcaCloudPkceFlowMock.mockImplementation(
    (_config, _profileId, onAuthorizeUrl: (url: string) => void) => {
      const url = `https://orca-cloud.example/authorize?attempt=${waits.length + 1}`
      onAuthorizeUrl(url)
      return new Promise((resolve, reject) => {
        waits.push({
          url,
          answer: (code) =>
            resolve({
              code,
              codeVerifier: 'verifier',
              nonce: 'nonce',
              redirectUri: 'http://127.0.0.1:4100/auth/callback',
              state: 'state'
            }),
          fail: reject
        })
      })
    }
  )
  return waits
}

describe('Orca cloud sign-in browser wait', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-cloud-sign-in-wait-'))
    beginOrcaCloudPkceFlowMock.mockReset()
    exchangeOrcaCloudAuthCodeMock.mockReset()
    vi.stubEnv('ORCA_CLOUD_API_URL', 'https://orca-cloud.example')
    vi.stubEnv('ORCA_CLOUD_CLIENT_ID', 'desktop-client')
  })

  afterEach(async () => {
    // Why: module state outlives a test; end any wait a test left open.
    await signOutCurrentOrcaProfile(userDataPath)
    rmSync(userDataPath, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('keeps the newest waiting link copyable until its wait times out', async () => {
    const waits = queueBrowserWaits()
    const first = connectCurrentOrcaProfile(userDataPath)
    const second = connectCurrentOrcaProfile(userDataPath)
    await vi.waitFor(() => expect(waits).toHaveLength(2))
    expect(getPendingOrcaCloudSignInLink()).toBe(waits[1].url)

    waits[0].fail(new Error('orca_cloud_auth_timeout'))
    await expect(first).resolves.toMatchObject({ status: 'cancelled' })
    expect(getPendingOrcaCloudSignInLink()).toBe(waits[1].url)

    waits[1].fail(new Error('orca_cloud_auth_timeout'))
    await expect(second).resolves.toMatchObject({ status: 'timed-out' })
    expect(getPendingOrcaCloudSignInLink()).toBeNull()
  })

  it('reports a denied browser sign-in as cancelled, not timed out', async () => {
    const waits = queueBrowserWaits()
    const attempt = connectCurrentOrcaProfile(userDataPath)
    await vi.waitFor(() => expect(waits).toHaveLength(1))

    waits[0].fail(new Error('orca_cloud_auth_denied'))
    await expect(attempt).resolves.toMatchObject({ status: 'cancelled' })
    expect(getPendingOrcaCloudSignInLink()).toBeNull()
  })

  it('drops the link once the browser answers, before the token exchange ends', async () => {
    const waits = queueBrowserWaits()
    exchangeOrcaCloudAuthCodeMock.mockReturnValue(new Promise(() => {}))
    void connectCurrentOrcaProfile(userDataPath)
    await vi.waitFor(() => expect(waits).toHaveLength(1))

    waits[0].answer('code')
    await vi.waitFor(() => expect(exchangeOrcaCloudAuthCodeMock).toHaveBeenCalledOnce())
    expect(getPendingOrcaCloudSignInLink()).toBeNull()
  })

  it('drops the waiting link on sign-out', async () => {
    const waits = queueBrowserWaits()
    const attempt = connectCurrentOrcaProfile(userDataPath)
    await vi.waitFor(() => expect(waits).toHaveLength(1))

    await signOutCurrentOrcaProfile(userDataPath)
    expect(getPendingOrcaCloudSignInLink()).toBeNull()
    waits[0].fail(new Error('orca_cloud_auth_timeout'))
    await expect(attempt).resolves.toMatchObject({ status: 'cancelled' })
  })
})
