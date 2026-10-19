/**
 * The GLM Coding Plan key on this host, shared by the desktop's IPC and the runtime RPC so a
 * paired client saves it where the usage poller runs. Nothing here may import Electron.
 */
import {
  clearZcodePlanApiKey,
  getZcodePlanApiKeyProtection,
  hasZcodePlanApiKey,
  readZcodePlanApiKey,
  saveZcodePlanApiKey
} from './zcode-plan-api-key-store'
import {
  credentialSealedElsewhere,
  refuseCredentialSealedElsewhere
} from '../credentials/credential-sealed-elsewhere'
import { hasZcodeCliPlanCredentials } from '../rate-limits/zcode-usage-fetcher'
import { refreshAfterCredentialChange } from '../ipc/credential-change-rate-limit-refresh'
import type { RateLimitService } from '../rate-limits/service'
import type { ZcodePlanCredentialsStatus } from '../../shared/zcode-plan-sites'

type UsageRefresher = Pick<RateLimitService, 'refresh' | 'invalidateZcodeCredentialState'>

export function getZcodePlanCredentialsStatus(): ZcodePlanCredentialsStatus {
  const apiKeyConfigured = hasZcodePlanApiKey()
  return {
    apiKeyConfigured,
    zcodeCliConfigured: hasZcodeCliPlanCredentials(),
    apiKeyProtection: getZcodePlanApiKeyProtection(),
    apiKeySealedElsewhere: credentialSealedElsewhere(() => apiKeyConfigured, readZcodePlanApiKey)
  }
}

/** For a paired client, before it saves or forgets: see refuseCredentialSealedElsewhere. */
export function assertZcodePlanApiKeyOpensHere(): void {
  if (credentialSealedElsewhere(hasZcodePlanApiKey, readZcodePlanApiKey)) {
    refuseCredentialSealedElsewhere('GLM Coding Plan API key')
  }
}

function refreshAfterChange(rateLimits: UsageRefresher | null, action: 'save' | 'clear'): void {
  refreshAfterCredentialChange(
    rateLimits,
    (service) => service.invalidateZcodeCredentialState(),
    `[zcode] failed to trigger rate-limit refresh after ${action}:`
  )
}

export function saveZcodePlanApiKeyCredential(
  rateLimits: UsageRefresher | null,
  key: unknown
): ZcodePlanCredentialsStatus {
  // Why: the value arrives as unknown over IPC/RPC; the declared type is compile-time only.
  if (typeof key !== 'string') {
    throw new Error('GLM Coding Plan API key must be a string')
  }
  saveZcodePlanApiKey(key)
  refreshAfterChange(rateLimits, 'save')
  return getZcodePlanCredentialsStatus()
}

export function clearZcodePlanApiKeyCredential(
  rateLimits: UsageRefresher | null
): ZcodePlanCredentialsStatus {
  clearZcodePlanApiKey()
  refreshAfterChange(rateLimits, 'clear')
  return getZcodePlanCredentialsStatus()
}
