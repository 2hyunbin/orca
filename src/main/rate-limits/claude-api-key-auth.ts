import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import type { ClaudeNoLoginAuth } from '../../shared/rate-limit-types'
import { claudeStateFile } from '../claude-accounts/claude-account-folder'
import type { ClaudeProfileRead } from '../claude-accounts/claude-profile-paths'
import { CLAUDE_AUTH_ENV_VARS } from '../claude-accounts/environment'
import { hasClaudeApiKeyKeychainItem } from '../claude-accounts/keychain'
import type { ClaudeOAuthCredentialReadOptions } from './claude-oauth-credentials'

// Why: these route Claude to another backend or credential, so "no API key" is not "not configured".
const OTHER_BACKEND_ENV = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY'
] as const
const OTHER_CREDENTIAL_ENV = [
  ...CLAUDE_AUTH_ENV_VARS.filter((name) => name !== 'ANTHROPIC_API_KEY'),
  'ANTHROPIC_BASE_URL'
]

type ClaudeApiKeyAuthOptions = ClaudeOAuthCredentialReadOptions & {
  env: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  userHome?: string
}

/**
 * How a host with no Claude login authenticates Claude, from presence alone: no key is read or kept.
 * Undefined when that cannot be told without launching Claude.
 */
export async function readClaudeNoLoginAuth(
  options: ClaudeApiKeyAuthOptions
): Promise<ClaudeNoLoginAuth | undefined> {
  const platform = options.platform ?? process.platform
  const userHome = options.userHome ?? homedir()
  const settings = await readJsonObject(
    path.join(options.credentialsFileConfigDir ?? path.join(userHome, '.claude'), 'settings.json')
  )
  const settingsEnv = settings.kind === 'present' ? stringRecord(settings.value.env) : {}
  // Why settings last: Claude applies its settings' env over the one it was started with.
  const isSet = (name: string): boolean =>
    Boolean(envValue(options.env, name, platform)?.trim() || settingsEnv[name]?.trim())
  if (OTHER_BACKEND_ENV.some(isSet)) {
    return undefined
  }
  if (isSet('ANTHROPIC_API_KEY') || hasText(settings, 'apiKeyHelper')) {
    return 'api-key'
  }
  const state = await readJsonObject(claudeStateFile(options.keychainConfigDir, userHome))
  if (hasText(state, 'primaryApiKey')) {
    return 'api-key'
  }
  const keychain = platform === 'darwin' ? await readKeychainApiKeyPresence(options) : false
  if (keychain === true) {
    return 'api-key'
  }
  if (
    keychain === undefined ||
    settings.kind === 'unavailable' ||
    state.kind === 'unavailable' ||
    OTHER_CREDENTIAL_ENV.some(isSet)
  ) {
    return undefined
  }
  return 'none'
}

/** Same Keychain items the OAuth read tries, under Claude's API-key service name. */
async function readKeychainApiKeyPresence(
  options: ClaudeOAuthCredentialReadOptions
): Promise<boolean | undefined> {
  try {
    if (
      options.keychainConfigDir &&
      (await hasClaudeApiKeyKeychainItem(options.keychainConfigDir))
    ) {
      return true
    }
    return !options.keychainConfigDir || options.unsuffixedKeychainFallback
      ? await hasClaudeApiKeyKeychainItem()
      : false
  } catch {
    return undefined
  }
}

async function readJsonObject(file: string): Promise<ClaudeProfileRead<Record<string, unknown>>> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'))
    return isRecord(value) ? { kind: 'present', value } : { kind: 'unavailable', error: null }
  } catch (error) {
    return isDefinitiveAbsence(error) ? { kind: 'absent' } : { kind: 'unavailable', error }
  }
}

function hasText(read: ClaudeProfileRead<Record<string, unknown>>, key: string): boolean {
  const value = read.kind === 'present' ? read.value[key] : undefined
  return typeof value === 'string' && value.trim() !== ''
}

function envValue(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform
): string | undefined {
  if (platform !== 'win32') {
    return env[name]
  }
  // Why: a copied Windows env keeps each key's own casing.
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name)
  return key === undefined ? undefined : env[key]
}

function stringRecord(value: unknown): Record<string, string> {
  return isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      )
    : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
