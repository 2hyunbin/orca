import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type * as AgentSources from './session-scanner-agent-sources'

vi.mock('./session-scanner-agent-sources', async (importOriginal) => {
  const original = await importOriginal<typeof AgentSources>()
  return { ...original, AI_VAULT_AGENT_SOURCES: { claude: original.AI_VAULT_AGENT_SOURCES.claude } }
})
vi.mock('./session-scanner-opencode-sources', () => ({ opencodeDiscoveries: () => [] }))
vi.mock('./session-scanner-zcode-sources', () => ({ zcodeDiscoveries: () => [] }))
vi.mock('./session-scanner-antigravity-sources', () => ({ antigravityDiscoveries: () => [] }))

import { discoverAiVaultSessionSources } from './session-scanner-source-discovery'
import { claudeProjectsRootDirs } from './session-scanner-roots'
import { validateAiVaultSessionDeleteTarget } from './session-delete-target'

it('walks history once when CLAUDE_CONFIG_DIR/projects links to ~/.claude/projects', async () => {
  const home = await mkdtemp(join(tmpdir(), 'orca-linked-history-'))
  try {
    const projects = join(home, '.claude', 'projects')
    // An Orca account home: its projects folder links to the default one.
    const configHome = join(home, 'account-home')
    const alias = join(configHome, 'projects')
    await mkdir(projects, { recursive: true })
    await mkdir(configHome)
    await writeFile(join(projects, 'session.jsonl'), '{}\n')
    await symlink(projects, alias, process.platform === 'win32' ? 'junction' : 'dir')
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    vi.stubEnv('CLAUDE_CONFIG_DIR', configHome)
    const discoveries = await discoverAiVaultSessionSources({
      options: {},
      limitPerAgent: 10,
      issues: []
    })
    expect(discoveries.map((discovery) => discovery.rootDir)).toEqual([alias])
    expect(discoveries.flatMap((discovery) => discovery.files.map((file) => file.path))).toEqual([
      join(alias, 'session.jsonl')
    ])
    expect(claudeProjectsRootDirs({})).toEqual([alias, projects])

    vi.stubEnv('ORCA_CLAUDE_INJECTED_CONFIG_DIR', configHome)
    vi.stubEnv('ORCA_CLAUDE_USER_CONFIG_DIR', undefined)
    const scan = () =>
      discoverAiVaultSessionSources({
        options: { claudeProfileProjectsDirs: [] },
        limitPerAgent: 10,
        issues: []
      })
    expect((await scan()).flatMap((row) => row.files.map((file) => file.path))).toEqual([
      join(projects, 'session.jsonl')
    ])
    expect(claudeProjectsRootDirs({ claudeProfileProjectsDirs: [] })).toEqual([projects, alias])
    expect(
      validateAiVaultSessionDeleteTarget({
        agent: 'claude',
        filePath: join(alias, 'session.jsonl'),
        executionHostId: 'local',
        rootOptions: { claudeProfileProjectsDirs: [] }
      }).allowed
    ).toBe(true)

    const independent = join(home, 'independent-projects')
    await mkdir(independent)
    await writeFile(join(independent, 'unique.jsonl'), '{}\n')
    await rm(alias)
    await symlink(independent, alias, process.platform === 'win32' ? 'junction' : 'dir')
    expect((await scan()).flatMap((row) => row.files.map((file) => file.path))).toEqual([
      join(projects, 'session.jsonl'),
      join(alias, 'unique.jsonl')
    ])
  } finally {
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  }
})
