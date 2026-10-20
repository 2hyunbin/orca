import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { CLAUDE_CLI_CONVERSATIONS } from '../claude/claude-cli-conversations'
import { structuredSessionRecoveryOptions } from './structured-session-recovery-options'

const homes = vi.hoisted((): { paths: string[] } => ({ paths: [] }))
vi.mock('../claude-accounts/claude-profile-installed-router', () => ({
  getClaudeProfileRouter: () => ({ accountSelectionHomes: async () => homes.paths })
}))
vi.mock('./structured-agent-runtime-metadata', () => ({
  structuredAgentRuntimeMetadata: () => ({
    ...CLAUDE_CLI_CONVERSATIONS,
    launchFollowsSelection: () => true
  })
}))

it('offers switching only when the real transcript store is shared with every destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usage-limit-actions-'))
  try {
    const system = join(root, 'default'),
      account = join(root, 'account'),
      isolated = join(root, 'isolated')
    const projects = join(system, 'projects')
    await mkdir(join(projects, 'workspace'), { recursive: true })
    await mkdir(account)
    await mkdir(join(isolated, 'projects', 'workspace'), { recursive: true })
    await symlink(
      projects,
      join(account, 'projects'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const transcript = join(projects, 'workspace', 'provider-session-alpha-1.jsonl')
    await writeFile(transcript, '{}\n')
    const record = agentSessionRecordFixture()
    record.accountHome = { variable: 'CLAUDE_CONFIG_DIR', path: account }
    homes.paths = [system, account]
    expect(await structuredSessionRecoveryOptions(record)).toMatchObject({
      canSwitchAccount: true,
      transcriptPath: expect.any(String)
    })
    const privateTranscript = join(
      isolated,
      'projects',
      'workspace',
      'provider-session-alpha-1.jsonl'
    )
    await writeFile(privateTranscript, '{}\n')
    record.accountHome = { variable: 'CLAUDE_CONFIG_DIR', path: isolated }
    expect(await structuredSessionRecoveryOptions(record)).toEqual({
      canSwitchAccount: false,
      transcriptPath: privateTranscript
    })
    record.accountHome = { variable: 'CLAUDE_CONFIG_DIR', path: account }
    homes.paths.push(isolated)
    expect((await structuredSessionRecoveryOptions(record)).canSwitchAccount).toBe(false)
    homes.paths = [system, join(root, 'unverified')]
    expect((await structuredSessionRecoveryOptions(record)).canSwitchAccount).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
