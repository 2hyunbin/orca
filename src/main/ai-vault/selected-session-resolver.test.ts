import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { resolveSelectedAccountTranscript } from '../native-chat/selected-cli-transcript'
import { prepareSelectedCodexAdoption } from '../native-chat/selected-codex-adoption-preparation'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  opendir,
  truncate,
  symlink,
  realpath
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SelectedSessionResultSchema } from '../../shared/ai-vault-selected-session-contract'
import { SELECTED_TRANSCRIPT_MAX_BYTES } from '../../shared/ai-vault-selected-session'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import {
  resolveSelectedSessionOnHost,
  type SelectedSessionRuntime
} from './selected-session-resolver'
import { readSelectedSessionFile } from './selected-session-file-reader'
import { resolveStructuredAgentSessionAdoptionForCreate } from '../runtime/structured-agent-session-create-adoption'
import { CLAUDE_CLI_CONVERSATIONS } from '../claude/claude-cli-conversations'

const mocks = vi.hoisted(() => {
  const state: { record: AgentSessionRecord | null } = { record: null }
  return {
    ...state,
    snapshot: vi.fn(),
    read: vi.fn(),
    list: vi.fn(() => {
      throw new Error('Global scanner unavailable')
    })
  }
})
vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({
    deps: {
      store: {
        getRecord: () => mocks.record,
        listRecords: () => (mocks.record ? [mocks.record] : [])
      }
    },
    journalSnapshot: mocks.snapshot
  })
}))
vi.mock('./selected-session-reader-client', () => ({
  readSelectedSessionInBackground: (...args: Parameters<typeof readSelectedSessionFile>) =>
    mocks.read(...args)
}))
vi.mock('./cached-session-list', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  listAiVaultSessions: mocks.list
}))
let root: string
let rows: AgentStatusIpcPayload[]
const runtime: SelectedSessionRuntime = {
  ensureStructuredAgentSessionHost: async () => {},
  getAgentProviderSessionRows: () => rows,
  resolveStructuredAgentAccountHome: async () => ({ variable: 'CLAUDE_CONFIG_DIR', path: root }),
  resolveStructuredAgentSessionLocalWorkspacePath: async () => '/repo'
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'selected-conversation-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', join(root, 'orca-data'))
  rows = []
  mocks.record = null
  mocks.read.mockImplementation(readSelectedSessionFile)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})
it('fork context uses host record, current workspace and real journal evidence without provider discovery', async () => {
  mocks.record = {
    ...agentSessionRecordFixture(),
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: root }
  }
  mocks.snapshot.mockImplementation(async () => {
    if (!mocks.record) {
      throw new Error('Missing source')
    }
    mocks.record = {
      ...mocks.record,
      providerHandleChain: mocks.record.providerHandleChain.map((link) => ({
        ...link,
        handle: claudeProviderHandle('provider-current', null)
      }))
    }
    return { items: [{ body: { kind: 'message', role: 'assistant' } }] }
  })
  const result = await resolveSelectedSessionOnHost(
    { kind: 'chat', sessionId: mocks.record.sessionId, workspaceId: 'workspace-1' },
    runtime,
    {}
  )
  expect(result).toMatchObject({
    status: 'ready',
    session: {
      sessionId: 'provider-current',
      cwd: '/repo',
      filePath: '',
      messageCount: 1,
      accountHome: mocks.record.accountHome,
      structuredSession: { sessionId: mocks.record.sessionId, workspaceId: 'workspace-1' }
    }
  })
  expect(mocks.list).not.toHaveBeenCalled()
})
it('selected CLI and admission share exact attested path/account, retaining saved cwd even when filename differs', async () => {
  const file = join(root, 'projects', 'bucket', 'different-file-id.jsonl')
  await mkdir(join(root, 'projects', 'bucket'), { recursive: true })
  await writeFile(
    file,
    `${JSON.stringify({
      type: 'user',
      sessionId: 'provider-1',
      cwd: '/repo/subfolder',
      message: { role: 'user', content: 'Keep this conversation' }
    })}\n`
  )
  rows = [
    {
      paneKey: 'tab-1:leaf-1',
      worktreeId: 'workspace-1',
      agentType: 'claude',
      providerSession: { key: 'session_id', id: 'provider-1', transcriptPath: file },
      connectionId: null,
      receivedAt: 1,
      stateStartedAt: 1,
      state: 'waiting',
      prompt: ''
    }
  ]
  const source = {
    kind: 'cli',
    agent: 'claude',
    providerSessionId: 'provider-1',
    paneKey: 'tab-1:leaf-1',
    workspaceId: 'workspace-1'
  } as const
  const result = await resolveSelectedSessionOnHost(source, runtime, {})
  expect(result).toMatchObject({
    status: 'ready',
    session: {
      sessionId: 'provider-1',
      cwd: '/repo/subfolder',
      filePath: file,
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: root }
    }
  })
  const importer = CLAUDE_CLI_CONVERSATIONS.transcriptImport
  if (!importer) {
    throw new Error('Missing importer')
  }
  expect(
    await resolveStructuredAgentSessionAdoptionForCreate({
      host: null,
      settings: {},
      agent: 'claude',
      transcriptImport: importer,
      providerSessionId: 'provider-1',
      selfSessionId: 'new-chat',
      selectedAccountHomePath: root,
      selectedSource: source,
      sourceRows: rows,
      sourceCwd: '/repo'
    })
  ).toEqual({ accountHomePath: root, transcriptPath: file })
  await writeFile(file, 'invalid saved history')
  await expect(resolveSelectedSessionOnHost(source, runtime, {})).rejects.toThrow(
    'could not be read'
  )
  expect(mocks.list).not.toHaveBeenCalled()
})
it('complete empty input differs from unreadable input, and an aborted reader never parses', async () => {
  const file = join(root, 'empty.jsonl')
  await writeFile(file, '')
  expect(
    await readSelectedSessionFile({ agent: 'claude', filePath: file, codexHome: null })
  ).toBeNull()
  await expect(
    readSelectedSessionFile({
      agent: 'claude',
      filePath: join(root, 'gone.jsonl'),
      codexHome: null
    })
  ).rejects.toThrow('ENOENT')
  const abort = new AbortController()
  abort.abort()
  await expect(
    readSelectedSessionFile({ agent: 'claude', filePath: file, codexHome: null }, abort.signal)
  ).rejects.toThrow()
})

it('attested account wins over another account alias until existing host preparation repins it', async () => {
  const sourceHome = join(root, '.orca', 'codex-accounts', 'account-a', 'home')
  const selectedHome = join(root, '.orca', 'codex-accounts', 'account-b', 'home')
  const relative = join('2026', '10', '13', 'rollout-provider-1.jsonl')
  const sourcePath = join(sourceHome, 'sessions', relative)
  const targetPath = join(selectedHome, 'sessions', relative)
  for (const home of [sourceHome, selectedHome]) {
    await mkdir(join(home, 'sessions', '2026', '10', '13'), { recursive: true })
    await writeFile(join(home, 'sessions', relative), '{}\n')
  }
  const resolved = await resolveSelectedAccountTranscript({
    agent: 'codex',
    providerSessionId: 'provider-1',
    selectedAccountHomePath: selectedHome,
    transcriptPath: sourcePath,
    cwd: '/repo',
    settings: { codexManagedAccounts: [{ managedHomePath: sourceHome }] }
  })
  expect(resolved).toEqual({ accountHomePath: sourceHome, transcriptPath: sourcePath })
  const prepare = vi.fn(async () => ({
    useRealCodexHome: false,
    substituteCodexHome: selectedHome
  }))
  expect(
    await prepareSelectedCodexAdoption(
      resolved,
      'provider-1',
      prepare,
      new AbortController().signal
    )
  ).toEqual({ accountHomePath: selectedHome, transcriptPath: targetPath })
  expect(prepare).toHaveBeenCalledOnce()
})

function cliSource(transcriptPath?: string) {
  const source = {
    kind: 'cli',
    agent: 'claude',
    providerSessionId: 'provider-1',
    paneKey: 'tab-1:leaf-1',
    workspaceId: 'workspace-1'
  } as const
  rows = [
    {
      paneKey: source.paneKey,
      worktreeId: source.workspaceId,
      agentType: source.agent,
      providerSession: { key: 'session_id', id: source.providerSessionId, transcriptPath },
      connectionId: null,
      receivedAt: 1,
      stateStartedAt: 1,
      state: 'waiting',
      prompt: ''
    }
  ]
  return source
}

it('finds and admits a small relocated transcript beyond the former directory quota', async () => {
  const projects = join(root, 'projects')
  for (let index = 0; index < 132; index++) {
    await mkdir(join(projects, `former-project-${index}`), { recursive: true })
  }
  const names: string[] = []
  for await (const entry of await opendir(projects)) {
    names.push(entry.name)
  }
  const bucket = names[66]
  if (!bucket) {
    throw new Error('Missing project fixture')
  }
  const file = join(projects, bucket, 'provider-1.jsonl')
  await writeFile(
    file,
    `${JSON.stringify({
      type: 'user',
      sessionId: 'provider-1',
      cwd: '/repo',
      message: { role: 'user', content: 'Keep the relocated conversation' }
    })}\n`
  )
  const source = cliSource()
  const result = await resolveSelectedSessionOnHost(source, runtime, {})
  expect(result).toMatchObject({
    status: 'ready',
    session: { filePath: file, cwd: '/repo', messageCount: 1 }
  })
  const importer = CLAUDE_CLI_CONVERSATIONS.transcriptImport
  if (!importer) {
    throw new Error('Missing importer')
  }
  await expect(
    resolveStructuredAgentSessionAdoptionForCreate({
      host: null,
      settings: {},
      agent: 'claude',
      transcriptImport: importer,
      providerSessionId: 'provider-1',
      selfSessionId: 'new-chat',
      selectedAccountHomePath: root,
      selectedSource: source,
      sourceRows: rows,
      sourceCwd: '/repo'
    })
  ).resolves.toEqual({ accountHomePath: root, transcriptPath: file })
  expect(mocks.list).not.toHaveBeenCalled()
})

it('answers existing ownership before account or provider-file eligibility, including oversized history', async () => {
  const file = join(root, 'unavailable.jsonl')
  const source = cliSource(file)
  const fixture = agentSessionRecordFixture()
  mocks.record = {
    ...fixture,
    location: { ...fixture.location, workspaceId: 'owner-workspace' },
    providerHandleChain: fixture.providerHandleChain.map((link) => ({
      ...link,
      handle: claudeProviderHandle('provider-1', null)
    }))
  }
  const account = vi
    .spyOn(runtime, 'resolveStructuredAgentAccountHome')
    .mockRejectedValue(new Error('Account unavailable'))
  const owned = await resolveSelectedSessionOnHost(source, runtime, {})
  expect(SelectedSessionResultSchema.parse(owned)).toMatchObject({
    status: 'ready',
    session: {
      structuredSession: { sessionId: fixture.sessionId, workspaceId: 'owner-workspace' }
    }
  })
  await writeFile(file, '')
  await truncate(file, SELECTED_TRANSCRIPT_MAX_BYTES + 1)
  expect(await resolveSelectedSessionOnHost(source, runtime, {})).toEqual(owned)
  expect(account).not.toHaveBeenCalled()
  expect(mocks.read).not.toHaveBeenCalled()
})

it('lookup and create reject escaped host paths while retaining an admitted account alias', async () => {
  const home = join(root, 'account')
  const projects = join(home, 'projects')
  await mkdir(projects, { recursive: true })
  const content = `${JSON.stringify({
    type: 'user',
    sessionId: 'provider-1',
    cwd: '/repo',
    message: { role: 'user', content: 'Retain my saved conversation' }
  })}\n`
  const file = join(projects, 'provider-1.jsonl')
  await writeFile(file, content)
  await writeFile(join(root, 'outside.jsonl'), content)
  vi.spyOn(runtime, 'resolveStructuredAgentAccountHome').mockResolvedValue({
    variable: 'CLAUDE_CONFIG_DIR',
    path: home
  })
  const importer = CLAUDE_CLI_CONVERSATIONS.transcriptImport
  if (!importer) {
    throw new Error('Missing importer')
  }
  const admit = (source: ReturnType<typeof cliSource>) =>
    resolveStructuredAgentSessionAdoptionForCreate({
      host: null,
      settings: {},
      agent: 'claude',
      transcriptImport: importer,
      providerSessionId: source.providerSessionId,
      selfSessionId: 'new-chat',
      selectedAccountHomePath: home,
      selectedSource: source,
      sourceRows: rows,
      sourceCwd: '/repo'
    })
  const escaped = cliSource(`${projects}/../../outside.jsonl`)
  await expect(resolveSelectedSessionOnHost(escaped, runtime, {})).rejects.toThrow('account')
  await expect(admit(escaped)).rejects.toThrow('account')
  const alias = join(root, 'account-alias')
  await symlink(home, alias, 'junction')
  const valid = cliSource(join(alias, 'projects', 'provider-1.jsonl'))
  const canonical = await realpath(file)
  await expect(resolveSelectedSessionOnHost(valid, runtime, {})).resolves.toMatchObject({
    status: 'ready',
    session: { filePath: canonical, cwd: '/repo', messageCount: 1 }
  })
  await expect(admit(valid)).resolves.toEqual({ accountHomePath: home, transcriptPath: canonical })
})
