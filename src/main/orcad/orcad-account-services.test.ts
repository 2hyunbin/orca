import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../persistence/loading-store/store'
import { ProfileStateSqliteAuthority } from '../persistence/profile-state/profile-state-sqlite-authority'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { eraseRpcMethods, isStreamingMethod } from '../runtime/rpc/core'
import { ACCOUNT_METHODS } from '../runtime/rpc/methods/accounts'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { installOrcadAccountServices } from './orcad-account-services'
import type { OrcadRuntimeCleanup } from './orcad-runtime-lifetime'

const directories: string[] = []
const stores: Store[] = []
let cleanups: OrcadRuntimeCleanup[] = []

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'orcad-account-services-'))
  directories.push(directory)
  return directory
}

beforeEach(() => {
  // Why a temp home and userData: the account services resolve ~/.codex, ~/.claude and their
  // managed homes from these, and a test must never touch the developer's own.
  const home = tempDirectory()
  const userData = tempDirectory()
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  // Why: the Codex runtime home reads this (as the host seeds it); otherwise XDG_CONFIG_HOME wins on CI.
  vi.stubEnv('ORCA_USER_DATA_PATH', userData)
  installFakeAppEnvironment({
    getPath: (name) => (name === 'home' ? home : name === 'temp' ? tmpdir() : userData)
  })
})

afterEach(async () => {
  for (const cleanup of cleanups.toReversed()) {
    await cleanup({ failed: false })
  }
  cleanups = []
  for (const store of stores.splice(0)) {
    store.freezeWrites()
  }
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createRuntime(): { runtime: OrcaRuntimeService; store: Store } {
  const directory = tempDirectory()
  const store = new Store({
    dataFile: join(directory, 'orca-data.json'),
    profileStateAuthority: new ProfileStateSqliteAuthority(
      join(directory, 'profile-state.db'),
      'orcad-account-services'
    )
  })
  stores.push(store)
  return { runtime: new OrcaRuntimeService(store), store }
}

function install(
  runtime: OrcaRuntimeService,
  store: Store,
  isWslHost: boolean
): ReturnType<typeof installOrcadAccountServices> {
  return installOrcadAccountServices({
    runtime,
    store,
    setClaudeStatusLineListener: vi.fn(),
    registerCleanup: (cleanup) => cleanups.push(cleanup),
    isWslHost: () => isWslHost
  })
}

async function call(runtime: OrcaRuntimeService, name: string, params: unknown): Promise<unknown> {
  const found = eraseRpcMethods(ACCOUNT_METHODS).find((candidate) => candidate.name === name)
  if (!found || isStreamingMethod(found)) {
    throw new Error(`Missing request method ${name}`)
  }
  return found.handler(found.params ? found.params.parse(params) : params, { runtime })
}

describe('orcad account services', () => {
  it('serves accounts.* from this host', async () => {
    const { runtime, store } = createRuntime()
    expect(install(runtime, store, false)).not.toBeNull()

    await expect(call(runtime, 'accounts.list', { refreshUsage: false })).resolves.toMatchObject({
      claude: { accounts: [], activeAccountId: null },
      codex: { accounts: [], activeAccountId: null },
      rateLimits: expect.any(Object)
    })
    await expect(
      call(runtime, 'accounts.selectClaude', { accountId: null })
    ).resolves.toMatchObject({ activeAccountId: null })
    await expect(call(runtime, 'accounts.selectCodex', { accountId: null })).resolves.toMatchObject(
      {
        activeAccountId: null
      }
    )
  })

  it('leaves a WSL host to the desktop that owns its accounts', async () => {
    const { runtime, store } = createRuntime()
    expect(install(runtime, store, true)).toBeNull()

    await expect(call(runtime, 'accounts.list', { refreshUsage: false })).rejects.toThrow(
      'Account services are not configured on this runtime'
    )
    // The desktop's push must still land.
    expect(() =>
      runtime.setHostAccountLaunchEnv({ wslDistro: 'Ubuntu', claude: {}, terminal: {} })
    ).not.toThrow()
  })
})
