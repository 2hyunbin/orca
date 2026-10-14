import type { SecretStore } from '../../shared/secret-store'
import { describeOrcadSecretProtectionGap } from './orcad-secret-protection-gap'

/**
 * Why not silently plaintext: `isEncryptionAvailable() === false` already makes every
 * caller fall back to unsealed storage, which is a security posture, not a detail.
 * `describeProtectionGap()` gives the reason a client can surface.
 */
export function createNodeSecretStore(): SecretStore {
  return {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('orcad_secret_sealing_unavailable')
    },
    decryptString: () => {
      throw new Error('orcad_secret_sealing_unavailable')
    },
    describeProtectionGap: () => describeOrcadSecretProtectionGap(process.platform)
  }
}
