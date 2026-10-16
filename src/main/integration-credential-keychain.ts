/**
 * What Linear and Jira status report about a host whose credential key sits in a lockable
 * keychain (orcad on macOS). Every field is optional so older clients ignore it.
 */
import type { IntegrationCredentialErrorReason } from '../shared/integration-credential-errors'
import {
  getSecretStore,
  hasSecretStore,
  type SecretStoreKeyMoveResult
} from '../shared/secret-store'
import { forgetIntegrationCredentialDecryptFailures } from './integration-token-file-cache'

export type IntegrationCredentialKeychainFields = {
  credentialErrorReason?: IntegrationCredentialErrorReason
  canMoveCredentialKeyToFile?: true
}

function keychainLock() {
  return hasSecretStore() ? getSecretStore().keychainLock : undefined
}

/** Retries a locked key before status is read, so an unlock shows up without a restart. */
export async function recoverIntegrationCredentialKey(): Promise<void> {
  if (await keychainLock()?.recover()) {
    forgetIntegrationCredentialDecryptFailures()
  }
}

export function integrationCredentialKeychainFields(
  hasSavedCredentials: boolean
): IntegrationCredentialKeychainFields {
  if (!hasSavedCredentials) {
    return {}
  }
  const state = keychainLock()?.state()
  if (state === 'locked') {
    return { credentialErrorReason: 'keychain_locked' }
  }
  // Why only after a lock: file storage is weaker, so offer it only to hosts that need it.
  return state === 'unlocked_after_lock' ? { canMoveCredentialKeyToFile: true } : {}
}

export async function moveIntegrationCredentialKeyToFile(): Promise<SecretStoreKeyMoveResult> {
  const lock = keychainLock()
  if (!lock) {
    return {
      ok: false,
      reason: 'not_in_keychain',
      message: 'This host does not keep its credential key in a keychain.'
    }
  }
  return lock.moveKeyToFile()
}
