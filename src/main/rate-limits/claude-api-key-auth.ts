import { homedir } from 'node:os'
import path from 'node:path'
import type { ClaudeNoLoginAuth } from '../../shared/rate-limit-types'
import { claudeStateFile } from '../claude-accounts/claude-account-folder'
import { CLAUDE_AUTH_ENV_VARS } from '../claude-accounts/environment'
import { hasClaudeApiKeyKeychainItem } from '../claude-accounts/keychain'
import type { ClaudeOAuthCredentialReadOptions } from './claude-oauth-credentials'
import {
  claudeManagedSettingsLocations,
  isRecord,
  readClaudeSettingsSources,
  readJsonObject,
  type ClaudeManagedSettingsLocations
} from './claude-settings-sources'

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
  managedSettings?: ClaudeManagedSettingsLocations
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
  const managed = options.managedSettings ?? claudeManagedSettingsLocations(platform)
  const settingsReads = await readClaudeSettingsSources(
    options.credentialsFileConfigDir ?? path.join(userHome, '.claude'),
    managed
  )
  const settings = settingsReads.flatMap((read) => (read.kind === 'present' ? [read.value] : []))
  const settingsEnv = settings.map((value) => stringRecord(value.env))
  // Why settings too: Claude applies its settings' env over the one it was started with.
  const isSet = (name: string): boolean =>
    Boolean(
      envValue(options.env, name, platform)?.trim() || settingsEnv.some((env) => env[name]?.trim())
    )
  if (OTHER_BACKEND_ENV.some(isSet)) {
    return undefined
  }
  if (isSet('ANTHROPIC_API_KEY') || settings.some((value) => hasText(value, 'apiKeyHelper'))) {
    return 'api-key'
  }
  const state = await readJsonObject(claudeStateFile(options.keychainConfigDir, userHome))
  if (state.kind === 'present' && hasText(state.value, 'primaryApiKey')) {
    return 'api-key'
  }
  const keychain = platform === 'darwin' ? await readKeychainApiKeyPresence(options) : false
  if (keychain === true) {
    return 'api-key'
  }
  if (
    keychain === undefined ||
    // Why: 'none' claims every source Claude reads was checked and empty.
    settingsReads.some((read) => read.kind === 'unavailable') ||
    managed.hasUncheckedStore ||
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

function hasText(value: Record<string, unknown>, key: string): boolean {
  const text = value[key]
  return typeof text === 'string' && text.trim() !== ''
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
