import { homedir } from 'node:os'
import path from 'node:path'
import type { ClaudeNoLoginAuth } from '../../shared/rate-limit-types'
import { claudeStateFile } from '../claude-accounts/claude-account-folder'
import { CLAUDE_AUTH_ENV_VARS } from '../claude-accounts/environment'
import { hasClaudeApiKeyKeychainItem } from '../claude-accounts/keychain'
import type { ClaudeOAuthCredentialReadOptions } from './claude-oauth-credentials'
import { readUserClaudeConfigDir } from '../claude-accounts/claude-profile-paths'
import {
  claudeManagedSettingsLocations,
  readClaudeAuthFileFacts,
  readClaudeSettingsSources,
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
  // Why: a Claude env setting can point Claude at another folder than the login read just checked.
  if (readUserClaudeConfigDir(options.env) !== options.keychainConfigDir) {
    return undefined
  }
  const managed = options.managedSettings ?? claudeManagedSettingsLocations(platform)
  const settingsReads = await readClaudeSettingsSources(
    options.credentialsFileConfigDir ?? path.join(userHome, '.claude'),
    managed
  )
  const settings = settingsReads.flatMap((read) => (read.kind === 'present' ? [read.value] : []))
  // Why settings too: Claude applies its settings' env over the one it was started with.
  const isSet = (name: string): boolean =>
    Boolean(envValue(options.env, name, platform)?.trim()) ||
    settings.some((facts) => facts.envNames.includes(name))
  if (OTHER_BACKEND_ENV.some(isSet)) {
    return undefined
  }
  if (isSet('ANTHROPIC_API_KEY') || settings.some((facts) => facts.apiKeyHelper)) {
    return 'api-key'
  }
  const state = await readClaudeAuthFileFacts(claudeStateFile(options.keychainConfigDir, userHome))
  if (state.kind === 'present' && state.value.primaryApiKey) {
    return 'api-key'
  }
  const keychain = platform === 'darwin' ? await cachedKeychainApiKeyPresence(options) : false
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

// Why cached: up to three `security` runs per no-login poll; a new Console login shows within the TTL.
const KEYCHAIN_PRESENCE_TTL_MS = 5 * 60_000
const keychainPresence = new Map<string, { at: number; present: boolean }>()

export function resetClaudeKeychainPresenceCacheForTests(): void {
  keychainPresence.clear()
}

async function cachedKeychainApiKeyPresence(
  options: ClaudeOAuthCredentialReadOptions
): Promise<boolean | undefined> {
  const key = `${options.keychainConfigDir ?? ''}\0${options.unsuffixedKeychainFallback ?? ''}`
  const cached = keychainPresence.get(key)
  if (cached && Date.now() - cached.at < KEYCHAIN_PRESENCE_TTL_MS) {
    return cached.present
  }
  const present = await readKeychainApiKeyPresence(options)
  if (present !== undefined) {
    keychainPresence.set(key, { at: Date.now(), present })
  }
  return present
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
