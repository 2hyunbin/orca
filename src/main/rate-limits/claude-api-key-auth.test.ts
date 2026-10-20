import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Keychain from '../claude-accounts/keychain'
import type * as ClaudeOAuthCredentials from './claude-oauth-credentials'
import type * as ClaudeSettingsSources from './claude-settings-sources'
import type { ClaudeManagedSettingsLocations } from './claude-settings-sources'

type Fixture = {
  hasKeychainKey: ReturnType<typeof vi.fn>
  readCredentials: ReturnType<typeof vi.fn>
  launchEnv: NodeJS.ProcessEnv
  envStatus: string
  userConfigDir?: string
  managed?: ClaudeManagedSettingsLocations
}

const fixture = vi.hoisted((): Fixture => ({
  hasKeychainKey: vi.fn(),
  readCredentials: vi.fn(),
  launchEnv: {},
  envStatus: 'captured'
}))

vi.mock('../claude-accounts/keychain', async (importOriginal) => ({
  ...(await importOriginal<typeof Keychain>()),
  hasClaudeApiKeyKeychainItem: fixture.hasKeychainKey
}))
vi.mock('./claude-oauth-credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof ClaudeOAuthCredentials>()),
  readClaudeOAuthCredentials: fixture.readCredentials
}))
vi.mock('./claude-settings-sources', async (importOriginal) => {
  const actual = await importOriginal<typeof ClaudeSettingsSources>()
  return {
    ...actual,
    claudeManagedSettingsLocations: (
      ...args: Parameters<typeof actual.claudeManagedSettingsLocations>
    ) => fixture.managed ?? actual.claudeManagedSettingsLocations(...args)
  }
})
vi.mock('../claude-accounts/claude-profile-installed-router', () => ({
  getClaudeProfileRouter: () => ({
    get envStatus() {
      return fixture.envStatus
    },
    claudeLaunchEnv: () => fixture.launchEnv,
    userConfigDir: () => fixture.userConfigDir
  })
}))

import {
  readClaudeNoLoginAuth,
  resetClaudeKeychainPresenceCacheForTests
} from './claude-api-key-auth'
import { fetchActiveClaudeRateLimits } from './claude-active-usage-fetch'
import {
  claudeManagedSettingsLocations,
  readClaudeAuthFileFacts,
  resetClaudeAuthFileFactsCacheForTests
} from './claude-settings-sources'

const SECRET = 'sk-ant-synthetic-secret-value'
let home: string
let configDir: string
let managedDir: string

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value))
}

function managedIn(
  dir: string,
  extra: Partial<ClaudeManagedSettingsLocations> = {}
): ClaudeManagedSettingsLocations {
  return {
    files: [join(dir, 'managed-settings.json')],
    dropInDirs: [join(dir, 'managed-settings.d')],
    opaqueFiles: [join(dir, 'policy.plist')],
    hasUncheckedStore: false,
    ...extra
  }
}

function detect(
  env: NodeJS.ProcessEnv = {},
  extra: { platform?: NodeJS.Platform; keychainConfigDir?: string } = {}
): ReturnType<typeof readClaudeNoLoginAuth> {
  return readClaudeNoLoginAuth({
    env,
    platform: extra.platform ?? 'linux',
    userHome: home,
    credentialsFileConfigDir: configDir,
    keychainConfigDir: extra.keychainConfigDir
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  home = mkdtempSync(join(tmpdir(), 'orca-claude-api-key-auth-'))
  configDir = join(home, '.claude')
  mkdirSync(configDir)
  managedDir = join(home, 'managed')
  fixture.managed = managedIn(managedDir)
  fixture.hasKeychainKey.mockResolvedValue(false)
  fixture.launchEnv = {}
  fixture.envStatus = 'captured'
  fixture.userConfigDir = undefined
  resetClaudeAuthFileFactsCacheForTests()
  resetClaudeKeychainPresenceCacheForTests()
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('readClaudeNoLoginAuth', () => {
  it('reports none when no key source exists', async () => {
    await expect(detect()).resolves.toBe('none')
  })

  it('finds ANTHROPIC_API_KEY in the launch env, case-insensitively on Windows', async () => {
    await expect(detect({ ANTHROPIC_API_KEY: SECRET })).resolves.toBe('api-key')
    await expect(detect({ Anthropic_Api_Key: SECRET }, { platform: 'win32' })).resolves.toBe(
      'api-key'
    )
    await expect(detect({ ANTHROPIC_API_KEY: '  ' })).resolves.toBe('none')
  })

  it("finds a key in the settings' env and an apiKeyHelper", async () => {
    writeJson(join(configDir, 'settings.json'), { env: { ANTHROPIC_API_KEY: SECRET } })
    await expect(detect()).resolves.toBe('api-key')
    writeJson(join(configDir, 'settings.json'), { apiKeyHelper: '/usr/local/bin/key' })
    await expect(detect()).resolves.toBe('api-key')
  })

  it("finds a Console login's primaryApiKey where Claude keeps its state file", async () => {
    writeJson(join(home, '.claude.json'), { primaryApiKey: SECRET })
    await expect(detect()).resolves.toBe('api-key')

    const customDir = join(home, 'custom-claude')
    mkdirSync(customDir)
    // Why: with CLAUDE_CONFIG_DIR set, Claude ignores the home state file.
    const custom = { CLAUDE_CONFIG_DIR: customDir }
    await expect(detect(custom, { keychainConfigDir: customDir })).resolves.toBe('none')
    writeJson(join(customDir, '.claude.json'), { primaryApiKey: SECRET })
    await expect(detect(custom, { keychainConfigDir: customDir })).resolves.toBe('api-key')
  })

  it("finds a Console login's Keychain item on macOS only", async () => {
    fixture.hasKeychainKey.mockResolvedValue(true)
    await expect(detect({}, { platform: 'darwin' })).resolves.toBe('api-key')
    await expect(detect()).resolves.toBe('none')
    expect(fixture.hasKeychainKey).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['Bedrock', { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: SECRET }],
    ['Vertex', { CLAUDE_CODE_USE_VERTEX: '1' }],
    ['a gateway without a key', { ANTHROPIC_BASE_URL: 'https://gateway.invalid' }],
    ['an auth token', { ANTHROPIC_AUTH_TOKEN: SECRET }],
    ['a long-lived OAuth token', { CLAUDE_CODE_OAUTH_TOKEN: SECRET }]
  ])('omits the answer for %s', async (_label, env) => {
    await expect(detect(env)).resolves.toBeUndefined()
  })

  it('omits the answer when settings route Claude to another backend', async () => {
    writeJson(join(configDir, 'settings.json'), { env: { CLAUDE_CODE_USE_BEDROCK: '1' } })
    await expect(detect()).resolves.toBeUndefined()
  })

  it('keeps a key behind a gateway as api-key', async () => {
    await expect(
      detect({ ANTHROPIC_BASE_URL: 'https://gateway.invalid', ANTHROPIC_API_KEY: SECRET })
    ).resolves.toBe('api-key')
  })

  it('omits the answer when a source cannot be read', async () => {
    writeFileSync(join(configDir, 'settings.json'), '{ not json')
    await expect(detect()).resolves.toBeUndefined()
    rmSync(join(configDir, 'settings.json'))
    fixture.hasKeychainKey.mockRejectedValue(new Error('keychain locked'))
    await expect(detect({}, { platform: 'darwin' })).resolves.toBeUndefined()
  })
})

describe('readClaudeNoLoginAuth settings sources', () => {
  it('finds a key or helper in settings.local.json', async () => {
    writeJson(join(configDir, 'settings.local.json'), { env: { ANTHROPIC_API_KEY: SECRET } })
    await expect(detect()).resolves.toBe('api-key')
    writeJson(join(configDir, 'settings.local.json'), { apiKeyHelper: '/usr/local/bin/key' })
    await expect(detect()).resolves.toBe('api-key')
  })

  it('finds a key or helper in managed settings and their drop-ins', async () => {
    mkdirSync(join(managedDir, 'managed-settings.d'), { recursive: true })
    writeJson(join(managedDir, 'managed-settings.json'), { apiKeyHelper: '/opt/key' })
    await expect(detect()).resolves.toBe('api-key')
    rmSync(join(managedDir, 'managed-settings.json'))
    writeJson(join(managedDir, 'managed-settings.d', '10-key.json'), {
      env: { ANTHROPIC_API_KEY: SECRET }
    })
    await expect(detect()).resolves.toBe('api-key')
  })

  it('omits the answer when managed settings route Claude elsewhere', async () => {
    mkdirSync(managedDir)
    writeJson(join(managedDir, 'managed-settings.json'), { env: { CLAUDE_CODE_USE_VERTEX: '1' } })
    await expect(detect()).resolves.toBeUndefined()
  })

  it.each([
    ['settings.local.json', () => writeFileSync(join(configDir, 'settings.local.json'), '{')],
    [
      'managed-settings.json',
      () => {
        mkdirSync(managedDir)
        writeFileSync(join(managedDir, 'managed-settings.json'), '[]')
      }
    ],
    [
      'a managed drop-in',
      () => {
        mkdirSync(join(managedDir, 'managed-settings.d'), { recursive: true })
        writeFileSync(join(managedDir, 'managed-settings.d', 'a.json'), 'nope')
      }
    ],
    [
      'a policy file Orca cannot parse',
      () => {
        mkdirSync(managedDir)
        writeFileSync(join(managedDir, 'policy.plist'), 'binary')
      }
    ]
  ])('omits rather than reporting none when %s cannot be checked', async (_label, arrange) => {
    arrange()
    await expect(detect()).resolves.toBeUndefined()
  })

  it('never reports none where a policy store goes unread, but still finds a key', async () => {
    fixture.managed = managedIn(managedDir, { hasUncheckedStore: true })
    await expect(detect()).resolves.toBeUndefined()
    await expect(detect({ ANTHROPIC_API_KEY: SECRET })).resolves.toBe('api-key')
  })

  it("names Claude Code's managed paths per OS", () => {
    fixture.managed = undefined
    expect(claudeManagedSettingsLocations('linux').files).toEqual([
      '/etc/claude-code/managed-settings.json'
    ])
    const mac = claudeManagedSettingsLocations('darwin')
    expect(mac.files).toEqual(['/Library/Application Support/ClaudeCode/managed-settings.json'])
    expect(mac.opaqueFiles[0]).toBe('/Library/Managed Preferences/com.anthropic.claudecode.plist')
    const win = claudeManagedSettingsLocations('win32', {
      ProgramFiles: 'D:\\Programs',
      ProgramData: 'D:\\Data'
    })
    expect(win.files).toEqual([
      'D:\\Programs\\ClaudeCode\\managed-settings.json',
      'D:\\Data\\ClaudeCode\\managed-settings.json'
    ])
    expect(win.hasUncheckedStore).toBe(true)
  })
})

describe('readClaudeNoLoginAuth folder and cost', () => {
  it("omits the answer when Claude's env names another folder than the one checked", async () => {
    const other = join(home, 'other')
    await expect(detect({ CLAUDE_CONFIG_DIR: other })).resolves.toBeUndefined()
    await expect(detect({}, { keychainConfigDir: other })).resolves.toBeUndefined()
    await expect(detect({ CLAUDE_CONFIG_DIR: other }, { keychainConfigDir: other })).resolves.toBe(
      'none'
    )
  })

  it('rereads a file only when its size or mtime changes', async () => {
    const file = join(configDir, 'settings.json')
    writeJson(file, { apiKeyHelper: 'a' })
    const first = await readClaudeAuthFileFacts(file)
    expect(await readClaudeAuthFileFacts(file)).toBe(first)
    writeJson(file, { apiKeyHelper: '' })
    await expect(readClaudeAuthFileFacts(file)).resolves.toMatchObject({
      value: { apiKeyHelper: false }
    })
  })

  it('keeps presence only, never a key value', async () => {
    writeJson(join(home, '.claude.json'), {
      primaryApiKey: SECRET,
      env: { ANTHROPIC_API_KEY: SECRET }
    })
    const facts = await readClaudeAuthFileFacts(join(home, '.claude.json'))
    expect(JSON.stringify(facts)).not.toContain(SECRET)
  })

  it('asks the Keychain once per TTL, and again after a failed lookup', async () => {
    fixture.hasKeychainKey.mockRejectedValueOnce(new Error('locked'))
    await expect(detect({}, { platform: 'darwin' })).resolves.toBeUndefined()
    await expect(detect({}, { platform: 'darwin' })).resolves.toBe('none')
    await expect(detect({}, { platform: 'darwin' })).resolves.toBe('none')
    expect(fixture.hasKeychainKey).toHaveBeenCalledTimes(2)
  })
})

describe('fetchActiveClaudeRateLimits with no Claude login', () => {
  beforeEach(() => {
    fixture.userConfigDir = configDir
    fixture.launchEnv = { CLAUDE_CONFIG_DIR: configDir }
    fixture.readCredentials.mockResolvedValue({
      token: null,
      hasRefreshableCredentials: false,
      source: 'none'
    })
  })

  function fetchSystemDefault(): ReturnType<typeof fetchActiveClaudeRateLimits> {
    return fetchActiveClaudeRateLimits({
      authPreparation: { configDir, envPatch: {}, provenance: 'system' }
    })
  }

  it('keeps what older clients see and adds claudeAuth, never the key', async () => {
    fixture.launchEnv = { CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: SECRET }
    writeJson(join(configDir, '.claude.json'), { primaryApiKey: SECRET })
    const result = await fetchSystemDefault()
    expect(result).toMatchObject({
      status: 'unavailable',
      error: 'No subscription plan — API key billing',
      usageMetadata: {
        failureKind: 'missing-credentials',
        authProvenance: 'system',
        claudeAuth: 'api-key'
      }
    })
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })

  it('reports none, and omits the field when it cannot tell', async () => {
    await expect(fetchSystemDefault()).resolves.toMatchObject({
      usageMetadata: { claudeAuth: 'none' }
    })
    fixture.launchEnv = { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_USE_VERTEX: '1' }
    const unknown = await fetchSystemDefault()
    expect(unknown.status).toBe('unavailable')
    expect(unknown.usageMetadata).not.toHaveProperty('claudeAuth')
  })

  it("omits the field until the login shell's env is captured", async () => {
    for (const status of ['pending', 'fallback']) {
      fixture.envStatus = status
      const result = await fetchSystemDefault()
      expect(result.status).toBe('unavailable')
      expect(result.usageMetadata).not.toHaveProperty('claudeAuth')
    }
  })

  it('never sets the field for a signed-out account', async () => {
    const result = await fetchActiveClaudeRateLimits({
      authPreparation: {
        configDir,
        envPatch: { CLAUDE_CONFIG_DIR: configDir },
        provenance: 'profile:A'
      }
    })
    expect(result.usageMetadata).toMatchObject({ failureKind: 'missing-credentials' })
    expect(result.usageMetadata).not.toHaveProperty('claudeAuth')
  })
})
