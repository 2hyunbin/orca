// After a restart, a settled chat lists with the status the last run saved, without opening its
// history. A chat the restart cut mid-turn is opened at once, and the verdict its journal's settle
// writes is the only one its row shows.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import {
  makeStructuredAgentStatusSubject,
  type AgentStatusStructuredSessionSubject
} from '../../../shared/agent-status-subject'
import { AgentHookServer } from '../../agent-hooks/server'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from '../../runtime/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

const FENCE = 7
const HANDLE = claudeProviderHandle('provider-session-alpha-1', null)
const NINE_DAYS_AGO = Date.now() - 9 * 24 * 60 * 60 * 1000
const record = (ownerHostId = 'local') =>
  agentSessionRecordFixture(
    agentSessionLeaseFixture({
      sessionId: SESSION,
      runtimeFence: FENCE,
      ownerProcess: { hostId: ownerHostId, pid: 4242, processStartTimeMs: 1, spawnToken: 'spawn' }
    })
  )
const SUBJECT = makeStructuredAgentStatusSubject(record().location, SESSION)

let root: string
let host: StructuredAgentSessionHost
let server: AgentHookServer
let rows: AgentSessionStatusSummary[]

/** The run before the restart: the chat's journal was mid-turn and the store saved `status`. */
async function previousRun(status: Partial<AgentSessionStatusSummary>, ownerHostId?: string) {
  await seedTestAgentSessionRecordStore(root, { records: [record(ownerHostId)] })
  const journal = await openAgentSessionJournal({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: HANDLE
    },
    database: openTestJournalHostDatabase(root),
    now: () => NINE_DAYS_AGO
  })
  const identity = { provider: 'claude' as const, sessionId: 'provider-session-alpha-1', uuid: 'u' }
  await journal.appendItem(
    identity,
    { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: NINE_DAYS_AGO },
    { fence: FENCE, turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(identity) } }
  )
  await journal.close()
  const before = new AgentHookServer()
  await before.start({ env: 'production', userDataPath: root })
  before.ingestStructuredStatus(
    {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      agent: 'claude',
      latestPrompt: 'run the loop',
      updatedAt: NINE_DAYS_AGO,
      status: 'idle',
      ...status
    },
    SUBJECT
  )
  before.stop()
}

/** What startup does: load the store, check leases, restore saved statuses, list tabs. */
async function restart(probe: AgentSessionOwnerProbe = { outcome: 'pid-absent' }) {
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: root })
  rows = []
  const publish = (
    summary: AgentSessionStatusSummary,
    subject: AgentStatusStructuredSessionSubject
  ) => {
    rows.push(summary)
    server.ingestStructuredStatus(summary, subject)
  }
  const onSessionStatusChanged = vi.fn()
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store: await openTestAgentSessionRecordStore(root),
    adapter: {
      acquire: vi.fn(),
      dispatch: vi.fn(),
      cancelTurn: vi.fn(),
      answerPrompt: vi.fn(),
      setOption: vi.fn()
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-new',
    probeOwner: async () => probe,
    now: () => Date.now(),
    statusSink: {
      publish,
      forget: (subject) => server.dropStructuredStatus(subject),
      dropSavedStatus: (sessionId) => server.dropSavedStructuredStatus(sessionId),
      readSavedStatuses: () => server.readSavedStructuredStatuses()
    },
    onSessionStatusChanged
  })
  await host.reconcileRestartLeases()
  await host.restore.restoreSavedStatuses([SESSION])
  return { onSessionStatusChanged }
}

async function turnState(): Promise<string | undefined> {
  const { items } = await host.journalSnapshot(SESSION)
  return items.map((item) => readAgentJournalTurn(item.body)).find(Boolean)?.state
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-saved-status-startup-'))
})

afterEach(async () => {
  await host?.flushAllStreamedEvents()
  server?.stop()
  closeTestJournalHostDatabases()
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe('a chat that was settled at the restart', () => {
  it.each([['success'], ['failure'], [undefined]] as const)(
    'lists with its saved status (outcome %s) days later, without opening its history',
    async (turnOutcome) => {
      const saved = turnOutcome ? { turnOutcome } : {}
      await previousRun({ status: 'idle', ...saved })

      const { onSessionStatusChanged } = await restart()

      expect(host.hasSession(SESSION)).toBe(false)
      expect(rows).toEqual([
        expect.objectContaining({ status: 'idle', ...saved, latestPrompt: 'run the loop' })
      ])
      expect(host.listSessionTabs([SESSION])).toEqual([
        { sessionId: SESSION, workspaceId: 'workspace-1', agent: 'claude' }
      ])
      // Mail and naming listen to journal edges; a saved status is not one.
      expect(onSessionStatusChanged).not.toHaveBeenCalled()
    }
  )
})

describe('a chat the restart cut mid-turn', () => {
  it.each(['working', 'attention'] as const)(
    'saved %s, is settled at startup and shows only Interrupted',
    async (status) => {
      await previousRun({ status })

      await restart()

      expect(await turnState()).toBe('interrupted')
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) {
        expect(row).toMatchObject({ status: 'idle', turnOutcome: 'interruption' })
      }
    }
  )

  it("reads Couldn't confirm when its agent may still be running", async () => {
    // An owner on another host outlives this restart, and no probe here can tell it is gone.
    await previousRun({ status: 'working' }, 'ssh:other')

    await restart({ outcome: 'indeterminate', reason: 'no scan here' })

    expect(await turnState()).toBe('unverifiable')
    expect(rows.at(-1)).toMatchObject({ status: 'idle', turnOutcome: 'unconfirmed' })
  })
})
