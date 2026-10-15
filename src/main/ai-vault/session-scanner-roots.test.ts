import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AI_VAULT_AGENT_SOURCES } from './session-scanner-agent-sources'
import { ompSessionsRootDirs } from './session-scanner-roots'
import { buildAiVaultServiceEnv } from './session-scanner-service-env'

describe('claude session roots', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // The CLI writes to CLAUDE_CONFIG_DIR; History listed only ~/.claude while chat read both.
  it('lists the CLAUDE_CONFIG_DIR tree ahead of the default home', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/opt/claude-home')

    expect(
      AI_VAULT_AGENT_SOURCES.claude.rootDirs({ claudeProfileProjectsDirs: [] }, ['/wsl/home/ada'])
    ).toEqual([
      join('/opt/claude-home', 'projects'),
      join(homedir(), '.claude', 'projects'),
      join('/wsl/home/ada', '.claude', 'projects')
    ])
  })

  it('keeps an explicit root as the only host root', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/opt/claude-home')

    expect(
      AI_VAULT_AGENT_SOURCES.claude.rootDirs(
        { claudeProjectsDir: '/scan/projects', claudeProfileProjectsDirs: [] },
        []
      )
    ).toEqual(['/scan/projects'])
  })

  it('scans the user home through the service boundary when Orca injected an account home', () => {
    const account = join(homedir(), 'orca-accounts', 'selected')
    const custom = join(homedir(), 'custom-claude')
    const defaultProjects = join(homedir(), '.claude', 'projects')
    for (const [config, user, expected] of [
      [account, undefined, [defaultProjects, join(account, 'projects')]],
      [account, custom, [join(custom, 'projects'), defaultProjects, join(account, 'projects')]],
      [custom, undefined, [join(custom, 'projects'), defaultProjects]],
      ['relative-home', undefined, [defaultProjects]]
    ] as const) {
      const childEnv = buildAiVaultServiceEnv({
        CLAUDE_CONFIG_DIR: config,
        ORCA_CLAUDE_INJECTED_CONFIG_DIR: account,
        ORCA_CLAUDE_USER_CONFIG_DIR: user
      })
      vi.stubEnv('CLAUDE_CONFIG_DIR', childEnv.CLAUDE_CONFIG_DIR)
      vi.stubEnv('ORCA_CLAUDE_INJECTED_CONFIG_DIR', childEnv.ORCA_CLAUDE_INJECTED_CONFIG_DIR)
      vi.stubEnv('ORCA_CLAUDE_USER_CONFIG_DIR', childEnv.ORCA_CLAUDE_USER_CONFIG_DIR)
      expect(
        AI_VAULT_AGENT_SOURCES.claude.rootDirs(
          { claudeProfileProjectsDirs: [] },
          ['/wsl/home/ada']
        )
      ).toEqual([...expected, join('/wsl/home/ada', '.claude', 'projects')])
    }
  })
})

describe('ompSessionsRootDirs', () => {
  it('drops a degenerate root that would resolve to the process cwd', () => {
    // normalizeAgentSessionsDir('/') returns ''. Kept, that root would resolve()
    // to the cwd and allowlist it for renderer-supplied subagent paths.
    expect(ompSessionsRootDirs({ ompSessionsDir: '' })).toEqual([])
    expect(ompSessionsRootDirs({ ompSessionsDir: '   ' })).toEqual([])
  })

  it('keeps the host root and one root per distinct WSL distro home', () => {
    expect(
      ompSessionsRootDirs({
        ompSessionsDir: '/home/ada/.omp/agent/sessions',
        wslHomeDirs: ['/wsl/ubuntu/home/ada', '/wsl/ubuntu/home/ada', '  ']
      })
    ).toEqual([
      '/home/ada/.omp/agent/sessions',
      join('/wsl/ubuntu/home/ada', '.omp', 'agent', 'sessions')
    ])
  })
})
