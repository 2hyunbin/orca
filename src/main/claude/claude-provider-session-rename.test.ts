import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import { renameClaudeProviderSession } from './claude-provider-session-rename'
import type { ClaudeSession } from './claude-structured-session-state'

let home: string
let conversation: string
let transcript: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'orca-claude-rename-'))
  conversation = randomUUID()
  const project = join(home, 'projects', 'workspace')
  await mkdir(project, { recursive: true })
  transcript = join(project, `${conversation}.jsonl`)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

const record = () =>
  agentSessionRecordFixture({
    sessionId: 'chat-1',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: home }
  })

it("writes Claude's own title line for a conversation no CLI is running, after a torn last line", async () => {
  const user = JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: conversation })
  await writeFile(transcript, `${user}\n{"type":"assistant","mess`)

  await renameClaudeProviderSession({
    session: undefined,
    record: record(),
    providerSessionId: conversation,
    name: 'Release notes',
    timeoutMs: undefined
  })

  const lines = (await readFile(transcript, 'utf8')).split('\n')
  expect(lines.slice(0, 2)).toEqual([user, '{"type":"assistant","mess'])
  expect(JSON.parse(lines[2] ?? '')).toMatchObject({
    type: 'custom-title',
    customTitle: 'Release notes',
    sessionId: conversation
  })
  expect(lines[3]).toBe('')
})

it('asks the running CLI to rename its own conversation instead of writing the file', async () => {
  await writeFile(transcript, '')
  const renameSession = vi.fn(async () => {})
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rename reads only the connection's closed flag and renameSession plus the session's provider id.
  const session = {
    providerSessionId: conversation,
    connection: { closed: false, renameSession }
  } as unknown as ClaudeSession

  await renameClaudeProviderSession({
    session,
    record: record(),
    providerSessionId: conversation,
    name: 'Release notes',
    timeoutMs: 5_000
  })

  expect(renameSession).toHaveBeenCalledWith('Release notes', conversation, { timeoutMs: 5_000 })
  expect(await readFile(transcript, 'utf8')).toBe('')
})
