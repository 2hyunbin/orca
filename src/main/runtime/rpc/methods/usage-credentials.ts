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
// Statuses carry presence and protection only; a key never travels back to a client. A host with
// no poller (a WSL host, whose desktop owns its accounts) refuses every call instead.
export const USAGE_CREDENTIAL_METHODS = [
  defineMethod({
    name: 'accounts.minimaxCredentialsStatus',
    permission: 'workspace',
    params: null,
    handler: async (_, { runtime }) => {
      runtime.requireUsageRateLimits()
      return getMiniMaxCredentialsStatus()
    }
  }),
  defineMethod({
    name: 'accounts.minimaxSaveApiKey',
    permission: 'accounts-admin',
    params: UsageCredentialApiKeyParams,
    handler: async ({ apiKey }, { runtime }) =>
      saveMiniMaxApiKeyCredential(runtime.requireUsageRateLimits(), apiKey)
  }),
  defineMethod({
    name: 'accounts.minimaxClearApiKey',
    permission: 'accounts-admin',
    params: null,
    handler: async (_, { runtime }) =>
      clearMiniMaxApiKeyCredential(runtime.requireUsageRateLimits())
  }),
  defineMethod({
    name: 'accounts.minimaxSaveSessionCookie',
    permission: 'accounts-admin',
    params: UsageCredentialSessionCookieParams,
    handler: async ({ cookie }, { runtime }) =>
      saveMiniMaxSessionCookieCredential(runtime.requireUsageRateLimits(), cookie)
  }),
  defineMethod({
    name: 'accounts.minimaxClearSessionCookie',
    permission: 'accounts-admin',
    params: null,
    handler: async (_, { runtime }) =>
      clearMiniMaxSessionCookieCredential(runtime.requireUsageRateLimits())
  }),
  defineMethod({
    name: 'accounts.zcodePlanCredentialsStatus',
    permission: 'workspace',
    params: null,
    handler: async (_, { runtime }) => {
      runtime.requireUsageRateLimits()
      return getZcodePlanCredentialsStatus()
    }
  }),
  defineMethod({
    name: 'accounts.zcodePlanSaveApiKey',
    permission: 'accounts-admin',
    params: UsageCredentialApiKeyParams,
    handler: async ({ apiKey }, { runtime }) =>
      saveZcodePlanApiKeyCredential(runtime.requireUsageRateLimits(), apiKey)
  }),
  defineMethod({
    name: 'accounts.zcodePlanClearApiKey',
    permission: 'accounts-admin',
    params: null,
    handler: async (_, { runtime }) =>
      clearZcodePlanApiKeyCredential(runtime.requireUsageRateLimits())
  })
] as const
