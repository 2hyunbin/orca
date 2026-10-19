import { defineMethod } from '../core'
import {
  UsageCredentialApiKeyParams,
  UsageCredentialSessionCookieParams
} from '../../../../shared/rpc-contract/usage-credentials-params'
import {
  clearMiniMaxApiKeyCredential,
  clearMiniMaxSessionCookieCredential,
  getMiniMaxCredentialsStatus,
  saveMiniMaxApiKeyCredential,
  saveMiniMaxSessionCookieCredential
} from '../../../minimax/minimax-credential-commands'
import {
  clearZcodePlanApiKeyCredential,
  getZcodePlanCredentialsStatus,
  saveZcodePlanApiKeyCredential
} from '../../../zcode/zcode-plan-credential-commands'

// Why on the host: its own usage poller reads these keys, so a paired client saves them here.
// Statuses carry presence and protection only; a key never travels back to a client.
export const USAGE_CREDENTIAL_METHODS = [
  defineMethod({
    name: 'accounts.minimaxCredentialsStatus',
    permission: 'workspace',
    params: null,
    handler: async () => getMiniMaxCredentialsStatus()
  }),
  defineMethod({
    name: 'accounts.minimaxSaveApiKey',
    permission: 'accounts-admin',
    params: UsageCredentialApiKeyParams,
    handler: async ({ apiKey }, { runtime }) =>
      saveMiniMaxApiKeyCredential(runtime.getUsageRateLimits(), apiKey)
  }),
  defineMethod({
    name: 'accounts.minimaxClearApiKey',
    permission: 'accounts-admin',
    params: null,
    handler: async (_, { runtime }) => clearMiniMaxApiKeyCredential(runtime.getUsageRateLimits())
  }),
  defineMethod({
    name: 'accounts.minimaxSaveSessionCookie',
    permission: 'accounts-admin',
    params: UsageCredentialSessionCookieParams,
    handler: async ({ cookie }, { runtime }) =>
      saveMiniMaxSessionCookieCredential(runtime.getUsageRateLimits(), cookie)
  }),
  defineMethod({
    name: 'accounts.minimaxClearSessionCookie',
    permission: 'accounts-admin',
    params: null,
    handler: async (_, { runtime }) =>
      clearMiniMaxSessionCookieCredential(runtime.getUsageRateLimits())
  }),
  defineMethod({
    name: 'accounts.zcodePlanCredentialsStatus',
    permission: 'workspace',
    params: null,
    handler: async () => getZcodePlanCredentialsStatus()
  }),
  defineMethod({
    name: 'accounts.zcodePlanSaveApiKey',
    permission: 'accounts-admin',
    params: UsageCredentialApiKeyParams,
    handler: async ({ apiKey }, { runtime }) =>
      saveZcodePlanApiKeyCredential(runtime.getUsageRateLimits(), apiKey)
  }),
  defineMethod({
    name: 'accounts.zcodePlanClearApiKey',
    permission: 'accounts-admin',
    params: null,
    handler: async (_, { runtime }) => clearZcodePlanApiKeyCredential(runtime.getUsageRateLimits())
  })
] as const
