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

it('discovers linked Claude history once through the first account spelling', async () => {
  const home = await mkdtemp(join(tmpdir(), 'orca-linked-history-'))
  try {
    const projects = join(home, 'projects')
    const profile = join(home, 'profile-projects')
    await mkdir(projects)
    await writeFile(join(projects, 'session.jsonl'), '{}\n')
    await symlink(projects, profile, process.platform === 'win32' ? 'junction' : 'dir')
    const options = { claudeProjectsDir: profile, claudeProfileProjectsDirs: [projects] }
    const discoveries = await discoverAiVaultSessionSources({
      options,
      limitPerAgent: 10,
      issues: []
    })
    expect(discoveries.map((discovery) => discovery.rootDir)).toEqual([profile])
    expect(discoveries.flatMap((discovery) => discovery.files.map((file) => file.path))).toEqual([
      join(profile, 'session.jsonl')
    ])
    expect(claudeProjectsRootDirs(options)).toEqual([profile, projects])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
