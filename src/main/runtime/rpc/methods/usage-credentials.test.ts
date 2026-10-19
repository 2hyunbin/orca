import '../unused-default-rpc-methods.test-fixture'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { setSecretStore } from '../../../../shared/secret-store'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { USAGE_CREDENTIAL_METHODS } from './usage-credentials'
import { RuntimeAccountController } from '../../runtime-account-controller'
import { hostAccountsManagedByDesktopMessage } from '../../../../shared/host-account-launch-env'

const home = vi.hoisted(() => ({ dir: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>()
  return { ...actual, homedir: () => home.dir }
})
// Why: the CLI sign-in probe reads platform credential stores this test must not touch.
vi.mock('../../../rate-limits/zcode-usage-fetcher', () => ({
  hasZcodeCliPlanCredentials: () => false
}))

const SECRET = 'sk-test-secret-value-1234'

function createRuntime() {
  const rateLimits = {
    refresh: vi.fn(() => Promise.resolve()),
    invalidateMiniMaxCredentialState: vi.fn(),
    invalidateZcodeCredentialState: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these methods only read requireUsageRateLimits; the dispatcher only reads getRuntimeId.
  const runtime = {
    getRuntimeId: () => 'runtime-a',
    requireUsageRateLimits: () => rateLimits
  } as unknown as OrcaRuntimeService
  return { runtime, rateLimits }
}

function call(dispatcher: RpcDispatcher, method: string, params?: unknown) {
  const request: RpcRequest = { id: method, authToken: 'token', method, params }
  return dispatcher.dispatch(request)
}

describe('usage credential RPC methods', () => {
  beforeEach(() => {
    home.dir = mkdtempSync(join(tmpdir(), 'orca-usage-credentials-'))
    // Why plaintext: orcad's sealing is covered elsewhere; this pins where the bytes land.
    setSecretStore({
      isEncryptionAvailable: () => false,
      encryptString: () => {
        throw new Error('unused')
      },
      decryptString: () => {
        throw new Error('unused')
      },
      describeProtectionGap: () => null
    })
  })

  afterEach(() => {
    rmSync(home.dir, { recursive: true, force: true })
  })

  it('saves and clears the MiniMax API key in this host’s ~/.orca and refreshes its usage', async () => {
    const { runtime, rateLimits } = createRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: [...USAGE_CREDENTIAL_METHODS] })
    const keyPath = join(home.dir, '.orca', 'minimax-api-key.enc')

    const saved = await call(dispatcher, 'accounts.minimaxSaveApiKey', { apiKey: SECRET })

    expect(saved).toMatchObject({
      ok: true,
      result: { apiKeyConfigured: true, apiKeyProtection: 'plaintext', configured: true }
    })
    expect(JSON.stringify(saved)).not.toContain(SECRET)
    expect(readFileSync(keyPath, 'utf8')).toContain(Buffer.from(SECRET).toString('base64'))
    expect(rateLimits.invalidateMiniMaxCredentialState).toHaveBeenCalledTimes(1)
    expect(rateLimits.refresh).toHaveBeenCalledTimes(1)
    await expect(call(dispatcher, 'accounts.minimaxCredentialsStatus')).resolves.toMatchObject({
      ok: true,
      result: { apiKeyConfigured: true, cookieConfigured: false }
    })

    await expect(call(dispatcher, 'accounts.minimaxClearApiKey')).resolves.toMatchObject({
      ok: true,
      result: { apiKeyConfigured: false, apiKeyProtection: null }
    })
    expect(existsSync(keyPath)).toBe(false)
    expect(rateLimits.refresh).toHaveBeenCalledTimes(2)
  })

  it('saves and clears the GLM Coding Plan key on this host', async () => {
    const { runtime, rateLimits } = createRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: [...USAGE_CREDENTIAL_METHODS] })

    const saved = await call(dispatcher, 'accounts.zcodePlanSaveApiKey', { apiKey: SECRET })

    expect(saved).toMatchObject({
      ok: true,
      result: { apiKeyConfigured: true, zcodeCliConfigured: false, apiKeyProtection: 'plaintext' }
    })
    expect(JSON.stringify(saved)).not.toContain(SECRET)
    expect(existsSync(join(home.dir, '.orca', 'zcode-plan-api-key.enc'))).toBe(true)
    expect(rateLimits.invalidateZcodeCredentialState).toHaveBeenCalledTimes(1)

    await expect(call(dispatcher, 'accounts.zcodePlanClearApiKey')).resolves.toMatchObject({
      ok: true,
      result: { apiKeyConfigured: false }
    })
    await expect(call(dispatcher, 'accounts.zcodePlanCredentialsStatus')).resolves.toMatchObject({
      ok: true,
      result: { apiKeyConfigured: false }
    })
  })

  it('refuses a MiniMax session cookie on a host with no browser cookie jar', async () => {
    const { runtime, rateLimits } = createRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: [...USAGE_CREDENTIAL_METHODS] })

    const refused = await call(dispatcher, 'accounts.minimaxSaveSessionCookie', { cookie: SECRET })

    expect(refused).toMatchObject({ ok: false })
    expect(JSON.stringify(refused)).not.toContain(SECRET)
    expect(existsSync(join(home.dir, '.orca', 'minimax-session-cookie.enc'))).toBe(false)
    expect(rateLimits.refresh).not.toHaveBeenCalled()
    await expect(call(dispatcher, 'accounts.minimaxCredentialsStatus')).resolves.toMatchObject({
      ok: true,
      result: { sessionCookieSupported: false }
    })
  })

  it('rejects an oversized key without echoing it', async () => {
    const { runtime } = createRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: [...USAGE_CREDENTIAL_METHODS] })
    const oversized = `${SECRET}${'x'.repeat(5_000)}`

    const refused = await call(dispatcher, 'accounts.minimaxSaveApiKey', { apiKey: oversized })

    expect(refused).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(JSON.stringify(refused)).not.toContain(SECRET)
    expect(existsSync(join(home.dir, '.orca', 'minimax-api-key.enc'))).toBe(false)
  })

  it('refuses every call where the desktop owns this host’s accounts, storing nothing', async () => {
    const accounts = new RuntimeAccountController()
    accounts.restoreHostLaunchEnv({ wslDistro: 'Ubuntu', claude: {}, terminal: {} }, () => {})
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above, backed by a real controller with no account services.
    const runtime = {
      getRuntimeId: () => 'runtime-a',
      requireUsageRateLimits: () => accounts.requireUsageRateLimits()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: [...USAGE_CREDENTIAL_METHODS] })

    for (const [method, params] of [
      ['accounts.zcodePlanSaveApiKey', { apiKey: SECRET }],
      ['accounts.minimaxSaveApiKey', { apiKey: SECRET }],
      ['accounts.minimaxCredentialsStatus', undefined],
      ['accounts.zcodePlanCredentialsStatus', undefined]
    ] as const) {
      await expect(call(dispatcher, method, params)).resolves.toMatchObject({
        ok: false,
        error: { message: hostAccountsManagedByDesktopMessage('Ubuntu') }
      })
    }
    expect(existsSync(join(home.dir, '.orca'))).toBe(false)
  })
})
