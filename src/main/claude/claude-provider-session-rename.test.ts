import { listSessions } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import * as transcriptFs from '../native-chat/wsl-transcript-fs-access'
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
  vi.restoreAllMocks()
  await rm(home, { recursive: true, force: true })
})

function input(session?: ClaudeSession, name = 'Release notes') {
  return {
    session,
    name,
    timeoutMs: undefined,
    providerSessionId: conversation,
    record: agentSessionRecordFixture({
      sessionId: 'chat-1',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: home }
    })
  }
}

it('makes the SDK picker read the saved title after a torn transcript tail', async () => {
  const user = JSON.stringify({
    type: 'user',
    uuid: randomUUID(),
    sessionId: conversation,
    message: { role: 'user', content: 'ship it' }
  })
  await writeFile(transcript, `${user}\n{"type":"assistant","mess`)
  await renameClaudeProviderSession(input())
  const lines = (await readFile(transcript, 'utf8')).split('\n')
  expect(lines.slice(0, 2)).toEqual([user, '{"type":"assistant","mess'])
  const listed = await listSessions({
    sessionStore: {
      load: async () => [JSON.parse(user), JSON.parse(lines[2] ?? '')],
      append: async () => {},
      listSessions: async () => [{ sessionId: conversation, mtime: 1_700_000_000_000 }]
    }
  })
  expect(listed[0]?.customTitle).toBe('Release notes')
})

it('waits for its retiring writer and refuses an unproven close before appending', async () => {
  await writeFile(transcript, '')
  const closing = Promise.withResolvers<boolean>()
  const exitVerdict = { root: 'live', tree: 'unverifiable' }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: rename reads only these session ownership/close fields.
  const session = {
    providerSessionId: conversation,
    closeFinalization: closing.promise,
    connection: { closed: true, exitVerdict }
  } as unknown as ClaudeSession
  const pending = renameClaudeProviderSession(input(session, 'New title'))
  await Promise.resolve()
  expect(await readFile(transcript, 'utf8')).toBe('')
  await writeFile(transcript, '{"type":"custom-title","customTitle":"Old title"}\n')
  closing.resolve(false)
  await expect(pending).rejects.toThrow('unproven transcript writer')
  expect(await readFile(transcript, 'utf8')).not.toContain('New title')
  exitVerdict.root = 'exited'
  await renameClaudeProviderSession(input(session, 'New title'))
  expect((await readFile(transcript, 'utf8')).trim().split('\n').at(-1)).toContain('New title')
})

it.each([10, 100])('visits each project once across %i projects', async (count) => {
  await writeFile(transcript, '')
  for (let i = 0; i < count; i += 1) {
    const project = join(home, 'projects', `project-${i}`)
    await mkdir(project)
    await Promise.all(
      Array.from({ length: 20 }, (_, j) => writeFile(join(project, `history-${j}.jsonl`), ''))
    )
  }
  const readDirectory = vi.spyOn(transcriptFs, 'wslGatedReaddir')
  await renameClaudeProviderSession(input())
  expect(readDirectory).toHaveBeenCalledTimes(count + 2)
  expect(new Set(readDirectory.mock.calls.map(([path]) => path)).size).toBe(count + 2)
})
