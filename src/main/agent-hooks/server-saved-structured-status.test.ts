// Native chats save their statuses whatever the status-hooks setting says. With hooks off nothing
// loads the CLI agents' rows, so a chat's save must write them back as it found them.

import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeStructuredAgentStatusSubject } from '../../shared/agent-status-subject'
import { AgentHookServer } from './server'
import { PANE, recentTs } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))

const CHAT = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const userDataPath = mkdtempSync(join(tmpdir(), 'orca-saved-chat-status-'))
const filePath = join(userDataPath, 'agent-hooks', 'last-status.json')
const readFile = () => JSON.parse(readFileSync(filePath, 'utf8'))

afterEach(() => rmSync(userDataPath, { recursive: true, force: true }))

it("keeps the CLI agents' rows when a chat saves with status hooks off", async () => {
  const receivedAt = recentTs()
  const cliRow = {
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    receivedAt,
    stateStartedAt: receivedAt,
    payload: { state: 'done', prompt: 'a CLI agent', agentType: 'claude' }
  }
  mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
  writeFileSync(filePath, JSON.stringify({ version: 2, entries: { [PANE]: cliRow } }))
  const server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath, statusHooksEnabled: false })
  const location = {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'workspace-1',
    workspaceKind: 'git-worktree'
  } as const

  server.ingestStructuredStatus(
    {
      sessionId: CHAT,
      workspaceId: 'workspace-1',
      agent: 'codex',
      status: 'idle',
      latestPrompt: 'x',
      updatedAt: Date.now()
    },
    makeStructuredAgentStatusSubject(location, CHAT)
  )
  server.stop()

  expect(readFile().entries).toEqual({ [PANE]: cliRow })
  expect(Object.keys(readFile().structuredSessions)).toEqual([CHAT])
})
