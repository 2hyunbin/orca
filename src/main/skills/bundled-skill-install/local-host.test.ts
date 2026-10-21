import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { detectMock } = vi.hoisted(() => ({ detectMock: vi.fn() }))
vi.mock('../../preflight/installed-agent-detection', () => ({
  detectInstalledAgentsWithShellPathHydration: detectMock
}))

import { localBundledSkillInput } from './local-host'

const HOME = join('/', 'home', 'u')
const USER_DATA = join('/', 'data', 'orca')

afterEach(() => {
  detectMock.mockReset()
  vi.unstubAllEnvs()
})

describe('localBundledSkillInput', () => {
  it('uses explicit agents without detecting, and the cloud-install state directory', async () => {
    const input = await localBundledSkillInput({
      userDataPath: USER_DATA,
      destination: { scope: 'global', homeDirectory: HOME },
      agents: [],
      providerRootOverrides: {},
      selection: { names: ['orca-cli'], force: 'all', installedOnly: true }
    })
    expect(detectMock).not.toHaveBeenCalled()
    expect(input).toEqual({
      destination: { scope: 'global', homeDirectory: HOME },
      agents: [],
      providerRootOverrides: {},
      stateDirectory: join(USER_DATA, 'skill-installs'),
      names: ['orca-cli'],
      force: 'all',
      installedOnly: true
    })
  })

  it('detects agents when none are given and keeps only ones Orca can place a skill for', async () => {
    detectMock.mockResolvedValue(['claude', 'aider', 'codex'])
    const input = await localBundledSkillInput({
      userDataPath: USER_DATA,
      destination: { scope: 'global', homeDirectory: HOME },
      providerRootOverrides: {},
      selection: {}
    })
    expect(input.agents).toEqual(['claude', 'codex'])
    expect(input).not.toHaveProperty('force')
    expect(input).not.toHaveProperty('installedOnly')
  })

  it('reads provider homes from the environment for global scope only', async () => {
    const claudeHome = join(HOME, 'custom-claude')
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeHome)
    const global = await localBundledSkillInput({
      userDataPath: USER_DATA,
      destination: { scope: 'global', homeDirectory: HOME },
      agents: ['claude'],
      selection: {}
    })
    expect(global.providerRootOverrides).toMatchObject({ claude: join(claudeHome, 'skills') })

    const workspace = await localBundledSkillInput({
      userDataPath: USER_DATA,
      destination: {
        scope: 'workspace',
        homeDirectory: HOME,
        workspaceDirectory: join(HOME, 'repo')
      },
      agents: ['claude'],
      selection: {}
    })
    expect(workspace.providerRootOverrides).toEqual({})
  })
})
