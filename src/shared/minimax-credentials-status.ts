import type { SecretAtRestProtection } from './secret-at-rest-protection'

export type MiniMaxCredentialsStatus = {
  configured: boolean
  cookieConfigured: boolean
  apiKeyConfigured: boolean
  /** How each stored credential sits on disk, so Settings can warn when it is unsealed. */
  cookieProtection: SecretAtRestProtection | null
  apiKeyProtection: SecretAtRestProtection | null
  /** False on a host without the desktop's cookie jar (orcad); older hosts omit it. */
  sessionCookieSupported?: boolean
}
