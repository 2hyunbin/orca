/**
 * orcad's SecretStore: credentials are sealed on the execution host, with a master key the
 * host owns — in the OS keyring when one is reachable when the key is first created, else in
 * a private file in the profile directory, bound to the machine ID.
 *
 * Why always "available": answering false makes every credential writer fall back to plaintext.
 * When the recorded key cannot be loaded (locked keyring, changed machine), seal and unseal
 * throw instead, so saves fail closed and existing sealed files are left untouched.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import type { SecretStore } from '../../shared/secret-store'
import { writeSecureFile } from '../../shared/secure-file'
import { profileStateAccessMachineIdentity } from '../persistence/profile-state/profile-state-access-identity'
import { resolveOrcadOsKeyring, type OrcadOsKeyring } from './orcad-os-keyring'
import {
  describeOrcadHostKeyGap,
  describeOrcadPlaintextOptOut,
  describeOrcadSealingUnavailable,
  ORCAD_PLAINTEXT_SECRETS_ENV
} from './orcad-secret-protection-gap'
import {
  deriveOrcadSealingKey,
  openOrcadSecret,
  ORCAD_MASTER_KEY_BYTES,
  orcadSealingKeyCheck,
  sealOrcadSecret
} from './orcad-secret-sealing'

export const ORCAD_SECRET_STATE_FILE = 'orcad-secret-store.json'

type StoredKeyState =
  | { version: 1; backend: 'os-keyring'; account: string; check: string }
  | { version: 1; backend: 'host-file'; key: string; hostBound: boolean; check: string }

type StoreState =
  | { kind: 'pending' }
  | { kind: 'plaintext' }
  | { kind: 'ready'; key: Buffer; gap: string | null }
  | { kind: 'unavailable'; message: string }

export type OrcadSecretStorePrepareOptions = {
  userDataPath: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  keyring?: OrcadOsKeyring | null
  machineIdentity?: () => string | null
}

export type OrcadSecretStore = SecretStore & {
  /** Resolves whether sealing works now, i.e. the key loaded. */
  prepare(options: OrcadSecretStorePrepareOptions): Promise<boolean>
}

function parseStoredState(raw: string): StoredKeyState | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  const record: Record<string, unknown> = { ...parsed }
  if (record.version !== 1 || typeof record.check !== 'string') {
    return null
  }
  if (record.backend === 'os-keyring' && typeof record.account === 'string') {
    return { version: 1, backend: 'os-keyring', account: record.account, check: record.check }
  }
  if (
    record.backend === 'host-file' &&
    typeof record.key === 'string' &&
    typeof record.hostBound === 'boolean'
  ) {
    return {
      version: 1,
      backend: 'host-file',
      key: record.key,
      hostBound: record.hostBound,
      check: record.check
    }
  }
  return null
}

function decodeMasterKey(encoded: string): Buffer | null {
  const key = Buffer.from(encoded, 'base64')
  return key.length === ORCAD_MASTER_KEY_BYTES ? key : null
}

function keyringAccount(userDataPath: string): string {
  // Why per profile: two orcad profiles under one account must not share or clobber a key.
  return `profile-${createHash('sha256').update(resolve(userDataPath)).digest('hex').slice(0, 16)}`
}

async function resolveState(options: OrcadSecretStorePrepareOptions): Promise<StoreState> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  if (env[ORCAD_PLAINTEXT_SECRETS_ENV] === 'plaintext') {
    return { kind: 'plaintext' }
  }
  const keyring =
    options.keyring === undefined ? resolveOrcadOsKeyring(platform, env) : options.keyring
  const machineIdentity = options.machineIdentity ?? profileStateAccessMachineIdentity
  const statePath = join(options.userDataPath, ORCAD_SECRET_STATE_FILE)
  const unavailable = (reason: string): StoreState => ({
    kind: 'unavailable',
    message: describeOrcadSealingUnavailable(reason, statePath)
  })

  if (existsSync(statePath)) {
    let stored: StoredKeyState | null
    try {
      stored = parseStoredState(readFileSync(statePath, 'utf8'))
    } catch (error) {
      return unavailable(`its key record could not be read (${String(error)})`)
    }
    if (!stored) {
      // Why not regenerate: the record may hold the only copy of the key.
      return unavailable(`its key record ${statePath} is not valid`)
    }
    if (stored.backend === 'os-keyring') {
      if (!keyring) {
        return unavailable('the OS keyring that holds its key is not reachable from this session')
      }
      const found = await keyring.lookup(stored.account)
      if (found.kind !== 'found') {
        return unavailable(
          found.kind === 'missing'
            ? `its key is missing from ${keyring.label}`
            : `${keyring.label} is locked or unreachable (${found.reason}); unlock it`
        )
      }
      const master = decodeMasterKey(found.value)
      const key = master ? deriveOrcadSealingKey(master, '') : null
      if (!key || orcadSealingKeyCheck(key) !== stored.check) {
        return unavailable(`the key in ${keyring.label} does not match the one it sealed with`)
      }
      return { kind: 'ready', key, gap: null }
    }
    const master = decodeMasterKey(stored.key)
    const binding = stored.hostBound ? machineIdentity() : ''
    if (!master || binding === null) {
      return unavailable('this machine no longer reports the machine ID its key is bound to')
    }
    const key = deriveOrcadSealingKey(master, binding)
    if (orcadSealingKeyCheck(key) !== stored.check) {
      return unavailable('its key is bound to a different machine ID')
    }
    return { kind: 'ready', key, gap: describeOrcadHostKeyGap(platform, stored.hostBound) }
  }

  if (keyring) {
    const account = keyringAccount(options.userDataPath)
    let found = await keyring.lookup(account)
    if (found.kind === 'missing') {
      const candidate = randomBytes(ORCAD_MASTER_KEY_BYTES).toString('base64')
      // Why read back: `security -i` exits 0 even when its command failed.
      found = (await keyring.store(account, candidate))
        ? await keyring.lookup(account)
        : { kind: 'unreachable', reason: 'store failed' }
    }
    const master = found.kind === 'found' ? decodeMasterKey(found.value) : null
    if (master) {
      const key = deriveOrcadSealingKey(master, '')
      const record: StoredKeyState = {
        version: 1,
        backend: 'os-keyring',
        account,
        check: orcadSealingKeyCheck(key)
      }
      if (writeStoredState(statePath, record)) {
        return { kind: 'ready', key, gap: null }
      }
      return unavailable(`its key record ${statePath} could not be written`)
    }
  }

  const binding = machineIdentity()
  const master = randomBytes(ORCAD_MASTER_KEY_BYTES)
  const key = deriveOrcadSealingKey(master, binding ?? '')
  const record: StoredKeyState = {
    version: 1,
    backend: 'host-file',
    key: master.toString('base64'),
    hostBound: binding !== null,
    check: orcadSealingKeyCheck(key)
  }
  // Why fail closed: sealing with a key that did not reach disk loses every credential on restart.
  if (!writeStoredState(statePath, record)) {
    return unavailable(`its key record ${statePath} could not be written`)
  }
  return { kind: 'ready', key, gap: describeOrcadHostKeyGap(platform, record.hostBound) }
}

function writeStoredState(path: string, record: StoredKeyState): boolean {
  try {
    writeSecureFile(path, JSON.stringify(record), { durable: true })
    return parseStoredState(readFileSync(path, 'utf8'))?.check === record.check
  } catch (error) {
    console.warn(
      `[secrets] could not write ${path}:`,
      error instanceof Error ? error.message : error
    )
    return false
  }
}

export function createOrcadSecretStore(): OrcadSecretStore {
  let state: StoreState = { kind: 'pending' }
  const readyKey = (): Buffer => {
    if (state.kind === 'ready') {
      return state.key
    }
    throw new Error(
      state.kind === 'unavailable'
        ? state.message
        : 'orcad_secret_store_not_prepared — the headless secret store has not loaded its key yet'
    )
  }
  return {
    isEncryptionAvailable: () => state.kind !== 'plaintext',
    encryptString: (plainText) => sealOrcadSecret(readyKey(), plainText),
    decryptString: (cipher) => openOrcadSecret(readyKey(), cipher),
    describeProtectionGap: () => {
      switch (state.kind) {
        case 'ready':
          return state.gap
        case 'unavailable':
          return state.message
        case 'plaintext':
          return describeOrcadPlaintextOptOut()
        case 'pending':
          return "Orca's headless server has not loaded its credential key yet."
      }
    },
    async prepare(options) {
      state = await resolveState(options)
      return state.kind === 'ready'
    }
  }
}
