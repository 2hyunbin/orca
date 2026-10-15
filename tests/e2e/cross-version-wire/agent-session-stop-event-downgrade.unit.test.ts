import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity,
  type AgentSessionJournalIdentity
} from '../../../src/shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../src/shared/agent-session-provider-handle-encoding'
import { createTrackedJournalOpener } from '../../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import type { JournalRow } from '../../../src/main/native-chat/agent-session-journal/journal-row-schema'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'
import { agentJournalItemKey } from '../../../src/shared/agent-session-journal-item-key'
import { agentSessionFailureFact } from '../../../src/shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../src/shared/agent-session-failure-words'
import {
  applyJournalRow,
  createJournalReducerState,
  renderJournalState
} from '../../../src/main/native-chat/agent-session-journal/journal-reducer'

// A release that knows none of the Stop event, the Resume marker and the reopen mark: an unknown
// row kind would make it delete the journal from that row on, so each rides a tombstone it reads.
const BASELINE_REF = 'v1.4.218'
const JOURNAL = 'src/main/native-chat/agent-session-journal'
const WRITABLE_BASELINE_REF = '3727100cc9dbcea6201f8a3e506676a3c4b53b18'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-downgrade',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}

test.each(['v1.4.219', 'v1.4.220', WRITABLE_BASELINE_REF])(
  '%s replays current raw rows with the unconfirmed failure intact',
  async (ref) => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-stop-note-raw-skew-'))
    const journals = createTrackedJournalOpener()
    try {
      const journal = await journals.open({ identity: IDENTITY, stateDirectory: directory })
      const turn = { provider: 'orca', clientMessageId: 'turn-raw-skew' } as const
      const note = { provider: 'orca', clientMessageId: 'stop:turn-raw-skew' } as const
      const unconfirmed = {
        kind: 'status' as const,
        ...agentSessionFailureWords(agentSessionFailureFact('cancelUnconfirmed'), {
          surface: 'row'
        })
      }
      await journal.appendItem(
        turn,
        {
          kind: 'status',
          text: 'Interrupted',
          turnLifecycle: { turnId: 'turn-raw-skew', state: 'interrupted' }
        },
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      await journal.appendItem(note, unconfirmed, {
        fence: 1,
        turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(turn) }
      })
      const since = journal.readSince({ epoch: journal.epoch, sequence: 0 })
      if (!since.ok) {
        throw new Error(since.reset)
      }
      const rawJson = JSON.stringify(since.rows)
      const checkout = await materializeReleaseCheckout(ref)
      const reducer = await importReleaseCheckoutModule(checkout, `${JOURNAL}/journal-reducer.ts`)
      const create = releaseExport<(sessionId: string, epoch: string) => OldReplay['state']>(
        reducer,
        'createJournalReducerState'
      )
      const fold = releaseExport<(state: OldReplay['state'], row: JournalRow) => void>(
        reducer,
        'applyJournalRow'
      )
      const old = create(IDENTITY.sessionId, journal.epoch)
      since.rows.forEach((row) => fold(old, row))
      expect(old.items.get(agentJournalItemKey(note))).toMatchObject({ body: unconfirmed })
      const current = createJournalReducerState(IDENTITY.sessionId, journal.epoch)
      since.rows.forEach((row) => applyJournalRow(current, row))
      expect(current.items.get(agentJournalItemKey(note))?.body).toEqual(unconfirmed)
      expect(
        renderJournalState(current).items.find((item) => item.itemId === agentJournalItemKey(note))
          ?.body
      ).toEqual({ kind: 'status', text: 'Cancellation requested.' })
      expect(JSON.stringify(since.rows)).toBe(rawJson)
      expect(journal.itemBody(agentJournalItemKey(note))).toEqual(unconfirmed)
    } finally {
      await journals.closeAll()
      rmSync(directory, { recursive: true, force: true })
    }
  },
  120_000
)

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

/** A function the pinned release exports, typed as the caller calls it. */
function releaseExport<T>(module: Record<string, unknown>, name: string): T {
  const value = module[name]
  if (typeof value !== 'function') {
    throw new Error(`the pinned release exports no ${name}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a function the pinned release exports; each caller names the signature it calls, and a changed one fails the test.
  return value as T
}

type OldReplay = {
  state: { items: Map<string, unknown> }
  readOnly: boolean
  corrupt: boolean
  malformedRows: number
  truncateFrom?: number
}

test("an older build keeps every row around a Stop's event, a Resume and a reopen mark, and folds the rows after them", async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-stop-event-downgrade-'))
  const journals = createTrackedJournalOpener()
  try {
    // This build: history, a person's Stop, a Resume, then more history.
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: directory })
    const append = (ordinal: number, text: string) =>
      journal.appendItem(
        item(ordinal),
        { kind: 'status', text },
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    await append(0, 'before the Stop')
    const beforeMarks = journal.cursor()
    await journal.appendStopEvent({ reason: 'user-stop', turnId: 'turn-1', caller: 'client-1' }, 1)
    await journal.appendStopEvent({ reason: 'user-close', turnId: 'turn-1' }, 1)
    await journal.appendQueueResume(1)
    await journal.appendQueueReopen(1)
    const afterMarks = journal.cursor()
    await append(1, 'after the Stop')
    const since = journal.readSince({ epoch: journal.epoch, sequence: 0 })
    if (!since.ok) {
      throw new Error(`expected rows, got reset ${since.reset}`)
    }
    const rows: JournalRow[] = since.rows

    const checkout = await materializeReleaseCheckout(BASELINE_REF)
    const [database, table, open, reducer, batch] = await Promise.all(
      [
        `${JOURNAL}/journal-database.ts`,
        `${JOURNAL}/journal-row-table.ts`,
        `${JOURNAL}/journal-open.ts`,
        `${JOURNAL}/journal-reducer.ts`,
        'src/main/native-chat/agent-session-wire/agent-session-journal-batch.ts'
      ].map((path) => importReleaseCheckoutModule(checkout, path))
    )
    const openJournalDatabase = releaseExport<(path: string) => { db: { close: () => void } }>(
      database,
      'openJournalDatabase'
    )
    const upsertJournalSessionRow = releaseExport<
      (...args: [unknown, string, string, number]) => void
    >(table, 'upsertJournalSessionRow')
    const insertJournalRow = releaseExport<(...args: [unknown, string, JournalRow]) => void>(
      table,
      'insertJournalRow'
    )
    const replayJournal = releaseExport<(...args: [unknown, boolean, string]) => OldReplay | null>(
      open,
      'replayJournal'
    )
    const renderJournalState = releaseExport<(state: unknown) => unknown>(
      reducer,
      'renderJournalState'
    )
    const projectJournalBatch = releaseExport<
      (input: { rows: readonly JournalRow[]; snapshot: unknown; afterSequence: number }) => {
        ok: boolean
        batch?: { items: unknown[]; removedItemIds: string[] }
      }
    >(batch, 'projectJournalBatch')

    const { db } = openJournalDatabase(join(directory, 'older-build-journal.sqlite'))
    try {
      upsertJournalSessionRow(db, IDENTITY.sessionId, journal.epoch, 1)
      for (const row of rows) {
        insertJournalRow(db, IDENTITY.sessionId, row)
      }
      const replayed = replayJournal(db, false, IDENTITY.sessionId)
      expect(replayed).toMatchObject({ readOnly: false, corrupt: false, malformedRows: 0 })
      expect(replayed?.truncateFrom).toBeUndefined()
      expect([...(replayed?.state.items.keys() ?? [])]).toHaveLength(2)

      // An older client is sent only ids no item uses, removed.
      const projected = projectJournalBatch({
        rows: rows.filter(
          (row) => row.seq > beforeMarks.sequence && row.seq <= afterMarks.sequence
        ),
        snapshot: renderJournalState(replayed?.state),
        afterSequence: beforeMarks.sequence
      })
      expect(projected.ok).toBe(true)
      expect(projected.batch?.items).toEqual([])
      expect(projected.batch?.removedItemIds).toHaveLength(3)
      const liveIds = new Set(journal.snapshot().items.map((entry) => entry.itemId))
      expect(projected.batch?.removedItemIds.some((id) => liveIds.has(id))).toBe(false)
    } finally {
      db.close()
    }
  } finally {
    await journals.closeAll()
    rmSync(directory, { recursive: true, force: true })
  }
}, 120_000)
