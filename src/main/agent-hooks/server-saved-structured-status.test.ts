// Native chat statuses saved in `last-status.json`, beside the CLI agents' rows, so a restart can list
// them without opening any chat. The store saves what it ingests, on the edges a restart would show.
// Chats have no status hooks, so none of this waits on that setting.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import { makeStructuredAgentStatusSubject } from '../../shared/agent-status-subject'
import { AgentHookServer, _internals } from './server'
import { PANE, recentTs } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

const CHAT = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const LOCATION = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
} as const
const SUBJECT = makeStructuredAgentStatusSubject(LOCATION, CHAT)
const NINE_DAYS_AGO = Date.now() - 9 * 24 * 60 * 60 * 1000

let userDataPath: string
const servers: AgentHookServer[] = []

beforeEach(() => {
  _internals.resetCachesForTests()
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-saved-chat-status-'))
})

afterEach(() => {
  servers.splice(0).forEach((server) => server.stop())
  vi.restoreAllMocks()
  rmSync(userDataPath, { recursive: true, force: true })
})

const lastStatusPath = () => join(userDataPath, 'agent-hooks', 'last-status.json')

function readFile(): {
  version?: number
  entries?: Record<string, unknown>
  structuredSessions?: Record<string, unknown>
} {
  // Writes are throttled in the background; read what the next write would land.
  servers.forEach((server) => server.flushStatusPersistSync())
  return JSON.parse(readFileSync(lastStatusPath(), 'utf8'))
}

function writeFile(file: unknown): void {
  mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
  writeFileSync(lastStatusPath(), JSON.stringify(file), 'utf8')
}

function live(fields: Partial<AgentSessionStatusSummary> = {}): AgentSessionStatusSummary {
  return {
    sessionId: CHAT,
    workspaceId: LOCATION.workspaceId,
    agent: 'codex',
    status: 'working',
    latestPrompt: 'refactor the parser',
    hostExecutionOwned: true,
    hostExecutionPhase: 'ready',
    model: 'gpt-live',
    toolName: 'Bash',
    lastAssistantMessage: 'Looking at it',
    updatedAt: Date.now(),
    ...fields
  }
}

function cliEntry() {
  const receivedAt = recentTs()
  return {
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    receivedAt,
    stateStartedAt: receivedAt,
    payload: { state: 'done', prompt: 'a CLI agent', agentType: 'claude' }
  }
}

async function start(statusHooksEnabled = true): Promise<AgentHookServer> {
  const server = new AgentHookServer()
  servers.push(server)
  await server.start({ env: 'production', userDataPath, statusHooksEnabled })
  return server
}

const savedChat = () => readFile().structuredSessions?.[CHAT]

describe('saving native chat statuses', () => {
  it("writes the journal's half at once, under its own key, with no debounce to wait out", async () => {
    const server = await start()

    server.ingestStructuredStatus(live(), SUBJECT)

    expect(readFile()).toMatchObject({ version: 2, entries: {} })
    expect(savedChat()).toEqual({
      summary: {
        sessionId: CHAT,
        status: 'working',
        latestPrompt: 'refactor the parser',
        lastAssistantMessage: 'Looking at it',
        updatedAt: expect.any(Number)
      }
    })
  })

  it('writes on a status or verdict edge, never for a streamed delta', async () => {
    const server = await start()
    server.ingestStructuredStatus(live(), SUBJECT)
    server.ingestStructuredStatus(
      live({ lastAssistantMessage: 'Found it', toolName: 'Edit' }),
      SUBJECT
    )
    expect(savedChat()).toMatchObject({ summary: { lastAssistantMessage: 'Looking at it' } })

    server.ingestStructuredStatus(live({ status: 'idle', turnOutcome: 'success' }), SUBJECT)
    server.ingestStructuredStatus(
      live({ status: 'idle', turnOutcome: 'success', lastAssistantMessage: 'Done' }),
      SUBJECT
    )
    expect(savedChat()).toMatchObject({
      summary: { turnOutcome: 'success', lastAssistantMessage: 'Looking at it' }
    })

    server.ingestStructuredStatus(live({ status: 'idle', turnOutcome: 'failure' }), SUBJECT)
    expect(savedChat()).toMatchObject({ summary: { turnOutcome: 'failure' } })
  })

  it('re-saves nothing a restart restores: what it loaded is what it compares against', async () => {
    writeFile({
      version: 2,
      entries: {},
      structuredSessions: {
        [CHAT]: {
          summary: {
            sessionId: CHAT,
            status: 'idle',
            turnOutcome: 'success',
            latestPrompt: 'saved',
            updatedAt: NINE_DAYS_AGO
          }
        }
      }
    })
    const before = readFileSync(lastStatusPath(), 'utf8')
    const server = await start()

    server.ingestStructuredStatus(
      live({ status: 'idle', turnOutcome: 'success', latestPrompt: 'restored' }),
      SUBJECT
    )

    expect(readFileSync(lastStatusPath(), 'utf8')).toBe(before)
  })

  it('lets the saved status die with the row when the host lets go of the chat', async () => {
    const server = await start()
    server.ingestStructuredStatus(live(), SUBJECT)

    server.dropStructuredStatus(SUBJECT)

    expect(readFile()).not.toHaveProperty('structuredSessions')
  })
})

describe('loading native chat statuses', () => {
  it('keeps an entry however old: records and tabs bound it, not its age', async () => {
    writeFile({
      version: 2,
      entries: {},
      structuredSessions: {
        [CHAT]: {
          summary: {
            sessionId: CHAT,
            status: 'working',
            latestPrompt: 'cut',
            updatedAt: NINE_DAYS_AGO
          }
        }
      }
    })

    const server = await start()

    expect(server.readSavedStructuredStatuses()).toEqual([
      { summary: expect.objectContaining({ status: 'working' }) }
    ])
  })

  it('loads and saves with status hooks off, writing back the CLI rows it never hydrated', async () => {
    writeFile({ version: 2, entries: { [PANE]: cliEntry() } })
    const before = readFile().entries
    const server = await start(false)

    server.ingestStructuredStatus(live(), SUBJECT)

    expect(readFile().entries).toEqual(before)
    expect(Object.keys(readFile().structuredSessions ?? {})).toEqual([CHAT])
  })

  it('never writes over a file it cannot read with status hooks off', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    writeFile({ version: 3, everything: 'a newer build keeps' })
    const before = readFileSync(lastStatusPath(), 'utf8')
    const server = await start(false)

    server.ingestStructuredStatus(live(), SUBJECT)
    server.stop()

    expect(readFileSync(lastStatusPath(), 'utf8')).toBe(before)
  })

  it('retries a failed write when Orca quits, whatever the status-hooks setting', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const server = await start(false)
    // A directory where the file goes fails the write's rename.
    mkdirSync(lastStatusPath(), { recursive: true })
    server.ingestStructuredStatus(live(), SUBJECT)
    rmSync(lastStatusPath(), { recursive: true })

    server.stop()

    expect(existsSync(lastStatusPath())).toBe(true)
    expect(Object.keys(readFile().structuredSessions ?? {})).toEqual([CHAT])
  })

  it("reads an older build's file, with no chat statuses, and keeps its CLI rows", async () => {
    writeFile({ version: 2, entries: { [PANE]: cliEntry() } })

    const server = await start()

    expect(server.readSavedStructuredStatuses()).toEqual([])
    expect(server.getStatusSnapshot().map((row) => row.paneKey)).toEqual([PANE])
  })
})
