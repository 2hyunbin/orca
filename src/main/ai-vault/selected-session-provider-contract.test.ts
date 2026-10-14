import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentSessionAccountHome } from '../../shared/agent-session-account-home'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import {
  CLI_CONVERSATION_ADOPTING_AGENTS,
  type CliConversationRowAgent
} from '../../shared/structured-agent-cli-conversation-adoption'
import { grokEncodedCwdDirName } from '../../shared/grok-session-paths'
import { SelectedSessionResultSchema } from '../../shared/ai-vault-selected-session-contract'
import { readSelectedSessionFile } from './selected-session-file-reader'
import {
  resolveSelectedSessionOnHost,
  type SelectedSessionRuntime
} from './selected-session-resolver'
import { structuredAgentRuntimeRegistration } from '../runtime/structured-agent-runtime-registrations'
import { resolveStructuredAgentSessionAdoptionForCreate } from '../runtime/structured-agent-session-create-adoption'
import SyncDatabase from '../sqlite/sync-database'
import { writeOpenCodeSqliteDatabase } from './session-scanner-opencode-sqlite-fixture'

vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({ deps: { store: { listRecords: () => [] } } })
}))
vi.mock('./selected-session-reader-client', () => ({
  readSelectedSessionInBackground: readSelectedSessionFile
}))
vi.mock('./session-scanner-opencode-sqlite-worker-spawn', async () => {
  const query = await import('../native-chat/transcript-opencode-sqlite-query')
  const v1 = await import('./session-scanner-opencode-sqlite')
  const v2 = await import('./session-scanner-opencode2-sqlite')
  return {
    readOpenCodeTranscriptSignalViaWorker: async (args: { dbPath: string; sessionId: string }) =>
      query.readOpenCodeTranscriptSignal(args.dbPath, args.sessionId),
    parseOpenCodeSqliteSessionViaWorker: v1.parseOpenCodeSqliteSession,
    parseOpenCode2SqliteSessionViaWorker: v2.parseOpenCode2SqliteSession
  }
})
vi.mock('../managed-data-accounts/service', () => ({
  getManagedDataAccountService: () => ({
    restoreOriginalEnvironment: () => {},
    environmentForAccount: () => ({ XDG_DATA_HOME: join(root, 'managed-data') })
  })
}))
const ID = '0198c2a4-7d1e-7c3a-9a4b-1f2e3d4c5b6a'
const CWD = '/repo/orca'
let root: string
let rows: AgentStatusIpcPayload[] = []
let account: AgentSessionAccountHome
let environment: Record<string, string>
let workspaceCwd: string
const runtime: SelectedSessionRuntime = {
  ensureStructuredAgentSessionHost: async () => {},
  getAgentProviderSessionRows: () => rows,
  resolveStructuredAgentAccountHome: async (_agent, launchEnv) => {
    expect(launchEnv).toEqual(environment)
    return account
  },
  resolveStructuredAgentSessionLocalWorkspacePath: async () => workspaceCwd,
  resolveStructuredAgentTranscriptImportContext: async () => ({
    launchEnv: environment,
    workspaceCwd
  })
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-selected-provider-'))
  vi.stubEnv('GROK_HOME', join(root, 'other-grok-home'))
  vi.stubEnv('ORCA_USER_DATA_PATH', join(root, 'orca-data'))
  environment = { HOME: root, USERPROFILE: root, XDG_DATA_HOME: join(root, 'data') }
  workspaceCwd = CWD
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})
function source(agent: CliConversationRowAgent) {
  const selected = {
    kind: 'cli',
    agent,
    providerSessionId: ID,
    paneKey: 'tab:leaf',
    workspaceId: 'workspace'
  } as const
  rows = [
    {
      paneKey: selected.paneKey,
      worktreeId: selected.workspaceId,
      agentType: CLI_CONVERSATION_ADOPTING_AGENTS[agent],
      providerSession: { key: 'session_id', id: ID },
      state: 'waiting',
      receivedAt: 1,
      stateStartedAt: 1,
      prompt: '',
      connectionId: null
    }
  ]
  return selected
}
async function admit(selected: ReturnType<typeof source>) {
  const agent = CLI_CONVERSATION_ADOPTING_AGENTS[selected.agent]
  const importer = structuredAgentRuntimeRegistration(agent)?.transcriptImport
  if (!importer) {
    throw new Error('Missing importer')
  }
  return resolveStructuredAgentSessionAdoptionForCreate({
    host: null,
    agent,
    settings: {},
    transcriptImport: importer,
    providerSessionId: ID,
    selfSessionId: 'new-chat',
    selectedAccountHome: account,
    launchEnv: environment,
    workspaceCwd,
    selectedSource: selected,
    sourceRows: rows,
    sourceCwd: workspaceCwd
  })
}

it('registered OMP lookup and create retain environment-root, actual account, cwd and content', async () => {
  account = { variable: 'PI_CODING_AGENT_DIR', path: join(root, '.omp', 'agent') }
  const file = join(
    root,
    'data',
    'omp',
    'sessions',
    '--repo-orca--',
    `2026-10-12T00-00-00-000Z_${ID}.jsonl`
  )
  await mkdir(dirname(file), { recursive: true })
  await writeFile(
    file,
    `${[
      { type: 'session', id: ID, cwd: CWD },
      { type: 'message', message: { role: 'user', content: 'Keep OMP content' } }
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')}\n`
  )
  const selected = source('omp')
  const result = SelectedSessionResultSchema.parse(
    await resolveSelectedSessionOnHost(selected, runtime, {})
  )
  expect(result).toMatchObject({
    status: 'ready',
    session: {
      agent: 'omp',
      filePath: file,
      cwd: CWD,
      accountHome: account,
      messageCount: 1,
      selectedSource: { paneKey: selected.paneKey }
    }
  })
  if (result.status !== 'ready') {
    throw new Error('Missing selected row')
  }
  expect(await admit(selected)).toEqual({ accountHome: account, transcriptPath: file })
})

it.each([false, true])(
  'registered OpenCode lookup/create keep typed account and actual schema alias (managed=%s)',
  async (managed) => {
    account = {
      kind: 'opencode',
      locator: managed
        ? { kind: 'managed', managedProfileId: '11111111-1111-4111-8111-111111111111' }
        : { kind: 'unmanaged' }
    }
    const file = join(root, managed ? 'managed-data' : 'data', 'opencode', 'opencode.db')
    if (!managed) {
      writeOpenCodeSqliteDatabase(file, [
        { id: ID, directory: CWD, turns: [{ role: 'user', parts: ['Keep OpenCode content'] }] }
      ])
    } else {
      await mkdir(dirname(file), { recursive: true })
      const db = new SyncDatabase(file)
      try {
        db.exec(
          `CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, time_created INTEGER, time_updated INTEGER); CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT, time_created INTEGER, time_updated INTEGER);`
        )
        db.prepare('INSERT INTO session_v2 VALUES (?, ?, 1, 1)').run(ID, CWD)
        db.prepare('INSERT INTO session_message VALUES (?, ?, ?, 1, ?, 1, 1)').run(
          'message',
          ID,
          'user',
          JSON.stringify({ text: 'Keep OpenCode 2 content' })
        )
      } finally {
        db.close()
      }
    }
    const selected = source(managed ? 'opencode2' : 'opencode')
    const result = SelectedSessionResultSchema.parse(
      await resolveSelectedSessionOnHost(selected, runtime, {})
    )
    expect(result).toMatchObject({
      status: 'ready',
      session: {
        agent: managed ? 'opencode2' : 'opencode',
        filePath: file,
        cwd: CWD,
        accountHome: account,
        messageCount: 1
      }
    })
    if (result.status !== 'ready') {
      throw new Error('Missing selected row')
    }
    expect(await admit(selected)).toEqual({ accountHome: account, transcriptPath: file })
  }
)

it.each([false, true])(
  'Grok selected resume reads saved summary authority and canonical content (long bucket=%s)',
  async (long) => {
    workspaceCwd = long ? `/repo/${'a'.repeat(280)}` : CWD
    account = { variable: 'GROK_HOME', path: root }
    const bucket = grokEncodedCwdDirName(workspaceCwd)
    if (!bucket) {
      throw new Error('Missing Grok bucket')
    }
    const file = join(root, 'sessions', bucket, ID, 'chat_history.jsonl')
    const summary = join(dirname(file), 'summary.json')
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify({ type: 'user', content: 'Keep Grok content' })}\n`)
    const selected = source('grok')
    const save = (cwd: string | null, id = ID) =>
      writeFile(summary, JSON.stringify({ info: { id, cwd }, num_messages: 99 }))
    await save(workspaceCwd)
    const read = () => resolveSelectedSessionOnHost(selected, runtime, {})
    const result = SelectedSessionResultSchema.parse(await read())
    if (result.status !== 'ready') {
      throw new Error('Missing selected row')
    }
    expect(result.session).toMatchObject({
      cwd: workspaceCwd,
      messageCount: 1,
      accountHome: account,
      filePath: file
    })
    expect(await admit(selected)).toEqual({ accountHome: account, transcriptPath: file })
    for (const cwd of ['/repo/other', null]) {
      await save(cwd)
      const mismatch = await read()
      if (mismatch.status !== 'ready') {
        throw new Error('Missing selected row')
      }
      expect(mismatch.session.cwd).toBe(cwd)
    }
    await save(workspaceCwd, 'different-session')
    await expect(read()).rejects.toThrow('different session')
    await rm(summary)
    await expect(read()).rejects.toThrow('ENOENT')
    await writeFile(summary, 'invalid summary')
    await expect(read()).rejects.toThrow()
    await writeFile(file, '')
    expect(await read()).toEqual({ status: 'missing' })
  }
)
