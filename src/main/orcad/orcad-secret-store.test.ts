import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { classifyUnenvelopedCredential } from '../../shared/secret-at-rest-protection'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secret-store'
import { readStoredCredentialToken, writeEncryptedCredential } from '../integration-credential-file'
import type { OrcadKeyringLookup, OrcadOsKeyring } from './orcad-os-keyring'
import { createOrcadSecretStore, ORCAD_SECRET_STATE_FILE } from './orcad-secret-store'

const MACHINE_A = '0123456789abcdef0123456789abcdef'
const MACHINE_B = 'fedcba9876543210fedcba9876543210'

type FakeKeyring = OrcadOsKeyring & {
  items: Map<string, string>
  failure: OrcadKeyringLookup | null
  storeWorks: boolean
}

function fakeKeyring(): FakeKeyring {
  const items = new Map<string, string>()
  const keyring: FakeKeyring = {
    label: 'the test keyring',
    items,
    failure: null,
    storeWorks: true,
    async lookup(account: string): Promise<OrcadKeyringLookup> {
      if (keyring.failure) {
        return keyring.failure
      }
      const value = items.get(account)
      return value ? { kind: 'found', value } : { kind: 'missing' }
    },
    async store(account: string, value: string): Promise<boolean> {
      if (keyring.storeWorks) {
        items.set(account, value)
      }
      return keyring.storeWorks
    }
  }
  return keyring
}

describe('createOrcadSecretStore', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orcad-secret-store-'))
  })

  afterEach(() => {
    _resetSecretStoreForTests()
    rmSync(userDataPath, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const prepare = async (
    options: {
      keyring?: OrcadOsKeyring | null
      machine?: string | null
      env?: NodeJS.ProcessEnv
    } = {}
  ) => {
    const store = createOrcadSecretStore()
    const ready = await store.prepare({
      userDataPath,
      platform: 'linux',
      env: options.env ?? {},
      keyring: options.keyring ?? null,
      machineIdentity: () => (options.machine === undefined ? MACHINE_A : options.machine)
    })
    return { store, ready }
  }

  it('seals with a host-bound profile key when no keyring is reachable', async () => {
    const { store, ready } = await prepare()
    expect(ready).toBe(true)
    expect(store.isEncryptionAvailable()).toBe(true)
    const sealed = store.encryptString('lin_api_secret')
    expect(sealed.includes(Buffer.from('lin_api_secret'))).toBe(false)
    expect(classifyUnenvelopedCredential(sealed)).toBe('sealed')
    expect(store.decryptString(sealed)).toBe('lin_api_secret')
    expect(store.describeProtectionGap()).toContain('bound to this machine')

    const statePath = join(userDataPath, ORCAD_SECRET_STATE_FILE)
    if (process.platform !== 'win32') {
      expect(statSync(statePath).mode & 0o777).toBe(0o600)
    }
    const reopened = (await prepare()).store
    expect(reopened.decryptString(sealed)).toBe('lin_api_secret')
  })

  it('refuses to seal or unseal, rather than downgrading, once the machine ID changes', async () => {
    const sealed = (await prepare()).store.encryptString('lin_api_secret')
    const stateBefore = readFileSync(join(userDataPath, ORCAD_SECRET_STATE_FILE))

    const { store, ready } = await prepare({ machine: MACHINE_B })
    expect(ready).toBe(false)
    expect(store.isEncryptionAvailable()).toBe(true)
    expect(() => store.encryptString('new')).toThrow(/different machine ID/)
    expect(() => store.decryptString(sealed)).toThrow(/different machine ID/)
    expect(readFileSync(join(userDataPath, ORCAD_SECRET_STATE_FILE))).toEqual(stateBefore)
  })

  it('keeps the master key in the OS keyring when one is reachable', async () => {
    const keyring = fakeKeyring()
    const { store, ready } = await prepare({ keyring })
    expect(ready).toBe(true)
    expect(store.describeProtectionGap()).toBeNull()
    expect(keyring.items.size).toBe(1)
    const [masterKey] = [...keyring.items.values()]
    expect(readFileSync(join(userDataPath, ORCAD_SECRET_STATE_FILE), 'utf8')).not.toContain(
      masterKey
    )
    const sealed = store.encryptString('lin_api_secret')
    // A different machine ID does not matter for a keyring-held key.
    expect((await prepare({ keyring, machine: MACHINE_B })).store.decryptString(sealed)).toBe(
      'lin_api_secret'
    )
  })

  it.each([
    ['locked', { kind: 'unreachable', reason: 'exited 1: Cannot unlock' }],
    ['timing out', { kind: 'unreachable', reason: 'timed out after 5s' }],
    ['missing its item', { kind: 'missing' }]
  ] as const)('fails closed when the recorded keyring is %s', async (_label, failure) => {
    const keyring = fakeKeyring()
    const sealed = (await prepare({ keyring })).store.encryptString('lin_api_secret')
    keyring.failure = failure

    const { store, ready } = await prepare({ keyring })
    expect(ready).toBe(false)
    expect(() => store.encryptString('x')).toThrow(/cannot unseal/)
    expect(() => store.decryptString(sealed)).toThrow(/cannot unseal/)
    expect(store.describeProtectionGap()).toContain('test keyring')

    keyring.failure = null
    expect((await prepare({ keyring })).store.decryptString(sealed)).toBe('lin_api_secret')
  })

  it('falls back to the profile key when the keyring cannot store one', async () => {
    const keyring = fakeKeyring()
    keyring.storeWorks = false
    const { store, ready } = await prepare({ keyring })
    expect(ready).toBe(true)
    expect(store.describeProtectionGap()).toContain('private profile directory')
  })

  it('never regenerates over an unreadable key record', async () => {
    const statePath = join(userDataPath, ORCAD_SECRET_STATE_FILE)
    writeFileSync(statePath, '{"version":1,"backend":"host-file"', 'utf8')
    const { store, ready } = await prepare()
    expect(ready).toBe(false)
    expect(() => store.encryptString('x')).toThrow(/not valid/)
    expect(readFileSync(statePath, 'utf8')).toBe('{"version":1,"backend":"host-file"')
  })

  it('records an unbound key when the host has no machine ID', async () => {
    const { store } = await prepare({ machine: null })
    expect(store.describeProtectionGap()).toContain('not bound to this machine')
    const sealed = store.encryptString('t')
    expect((await prepare({ machine: MACHINE_B })).store.decryptString(sealed)).toBe('t')
  })

  it('keeps the explicit plaintext opt-out for shared homes', async () => {
    const { store, ready } = await prepare({ env: { ORCA_HEADLESS_SECRET_STORE: 'plaintext' } })
    expect(ready).toBe(false)
    expect(store.isEncryptionAvailable()).toBe(false)
    expect(store.describeProtectionGap()).toContain('ORCA_HEADLESS_SECRET_STORE=plaintext')
  })

  it('makes integration credential saves seal, and still reads legacy plaintext', async () => {
    const { store } = await prepare()
    setSecretStore(store)
    const legacy = join(userDataPath, 'legacy.enc')
    writeFileSync(legacy, 'lin_api_legacy', 'utf8')
    expect(readStoredCredentialToken('Linear', readFileSync(legacy))).toBe('lin_api_legacy')

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const saved = join(userDataPath, 'saved.enc')
    writeEncryptedCredential('Linear', saved, 'lin_api_new')
    expect(warn).not.toHaveBeenCalled()
    expect(readFileSync(saved).includes(Buffer.from('lin_api_new'))).toBe(false)
    expect(readStoredCredentialToken('Linear', readFileSync(saved))).toBe('lin_api_new')
  })

  it('fails a save closed when the key cannot load, keeping the sealed file', async () => {
    const saved = join(userDataPath, 'saved.enc')
    setSecretStore((await prepare()).store)
    writeEncryptedCredential('Linear', saved, 'lin_api_original')
    const before = readFileSync(saved)

    setSecretStore((await prepare({ machine: MACHINE_B })).store)
    expect(() => writeEncryptedCredential('Linear', saved, 'lin_api_replacement')).toThrow()
    expect(readFileSync(saved)).toEqual(before)
  })
})
