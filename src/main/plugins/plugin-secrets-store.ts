import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { getSecretStore } from '../../shared/secret-store'
import { isUnreadableError, writeSecureFile } from '../../shared/secure-file'
import {
  PLUGIN_STORAGE_KEY_LIMIT,
  PLUGIN_STORAGE_TOTAL_MAX_BYTES
} from '../../shared/plugins/plugin-host-api'
import { pluginDataDir } from './plugin-storage-store'

/**
 * Per-plugin secret vault, using the host's protected secret backend and
 * credential-file pattern (versioned envelope + base64 ciphertext via the
 * atomic secure-file writer). No plaintext fallback: when OS encryption is
 * unavailable, writes fail loudly instead of silently downgrading — plugin
 * secrets are API-token grade.
 */

const persistedSecretsSchema = z.discriminatedUnion('format', [
  z.strictObject({
    version: z.literal(1),
    format: z.literal('electron-safe-storage-v1'),
    ciphertexts: z.record(z.string(), z.string())
  }),
  z.strictObject({
    version: z.literal(2),
    format: z.literal('host-secret-store-v1'),
    ciphertexts: z.record(z.string(), z.string())
  })
])
type PersistedSecretsFile = z.infer<typeof persistedSecretsSchema>

export type PluginSecretsResult<T> = { ok: true; value: T } | { ok: false; error: string }

const UNREADABLE_VAULT_ERROR = 'secret vault exists but could not be read; refusing to overwrite it'

export class PluginSecretsStore {
  private readonly filePath: string

  constructor(pluginsDataDir: string, qualifiedKey: string) {
    this.filePath = join(pluginDataDir(pluginsDataDir, qualifiedKey), 'secrets.json.enc')
  }

  /** `null` means the vault exists and this process may not read it — which is never "empty". */
  private read(): PersistedSecretsFile | null {
    const empty: PersistedSecretsFile = {
      version: 2,
      format: 'host-secret-store-v1',
      ciphertexts: {}
    }
    try {
      if (!existsSync(this.filePath)) {
        return empty
      }
      if (statSync(this.filePath).size > PLUGIN_STORAGE_TOTAL_MAX_BYTES) {
        return null
      }
      const parsed = persistedSecretsSchema.safeParse(
        JSON.parse(readFileSync(this.filePath, 'utf8'))
      )
      if (parsed.success) {
        return parsed.data
      }
      return null
    } catch (error) {
      // Being denied the read is not evidence the vault is corrupt. Returning `empty` here would
      // make the next set() write a vault containing only that one key, silently dropping every
      // secret the file still holds — and the write would succeed.
      if (isUnreadableError(error)) {
        return null
      }
      return null
    }
  }

  get(key: string): PluginSecretsResult<string | null> {
    const file = this.read()
    if (!file) {
      return { ok: false, error: UNREADABLE_VAULT_ERROR }
    }
    const ciphertext = file.ciphertexts[key]
    if (typeof ciphertext !== 'string') {
      return { ok: true, value: null }
    }
    if (!getSecretStore().isEncryptionAvailable()) {
      return { ok: false, error: 'OS-backed encryption is unavailable' }
    }
    try {
      return { ok: true, value: getSecretStore().decryptString(Buffer.from(ciphertext, 'base64')) }
    } catch {
      return { ok: false, error: 'failed to decrypt stored secret' }
    }
  }

  set(key: string, value: string): PluginSecretsResult<true> {
    if (
      !getSecretStore().isEncryptionAvailable() ||
      getSecretStore().describeProtectionGap() !== null
    ) {
      return { ok: false, error: 'Protected host encryption is unavailable; secret not stored' }
    }
    const file = this.read()
    if (!file) {
      return { ok: false, error: UNREADABLE_VAULT_ERROR }
    }
    if (
      !Object.hasOwn(file.ciphertexts, key) &&
      Object.keys(file.ciphertexts).length >= PLUGIN_STORAGE_KEY_LIMIT
    ) {
      return { ok: false, error: `secret vault exceeds the ${PLUGIN_STORAGE_KEY_LIMIT}-key limit` }
    }
    file.ciphertexts[key] = getSecretStore().encryptString(value).toString('base64')
    const nextFile = JSON.stringify(
      { ...file, version: 2, format: 'host-secret-store-v1' },
      null,
      2
    )
    if (Buffer.byteLength(nextFile, 'utf8') > PLUGIN_STORAGE_TOTAL_MAX_BYTES) {
      return { ok: false, error: `secret vault exceeds ${PLUGIN_STORAGE_TOTAL_MAX_BYTES} bytes` }
    }
    writeSecureFile(this.filePath, nextFile)
    return { ok: true, value: true }
  }

  delete(key: string): void {
    const file = this.read()
    if (!file) {
      // Rewriting what we could not read would drop every other secret in the vault.
      return
    }
    if (Object.hasOwn(file.ciphertexts, key)) {
      delete file.ciphertexts[key]
      writeSecureFile(this.filePath, JSON.stringify(file, null, 2))
    }
  }
}
