import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  type AgentSessionJournalIdentity
} from '../../../src/shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../src/shared/agent-session-provider-handle-encoding'
import type { AgentSessionRefusalReference } from '../../../src/shared/agent-session-wire-refusals'
import {
  closeTestJournalHostDatabase,
  createTrackedJournalOpener,
  insertTestJournalRowJson,
  openTestJournalHostDatabase,
  SAVED_BY_NEWER_ORCA
} from '../../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import { journalOpenRefusal } from '../../../src/main/native-chat/agent-session-journal/journal-open-failure'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef
} from './release-checkout'

/**
 * A chat a newer Orca saved now fails its load here with the newer-Orca reason, where this host used
 * to serve it read-only (Rule 3: an existing read answers differently). An older client gets that
 * refusal instead of pages: it must word it with what it has and never call it damage.
 */
const SUITE_TIMEOUT_MS = 180_000
// The last release that does not know the newer-Orca reason: its words fall back to the code's.
const BEFORE_NEWER_REASON_REF = 'v1.4.218'
const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-newer-chat',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}

type ReadHistoryParts = (code: string, details?: unknown, context?: unknown) => unknown[]
type NoticeEnglish = (parts: unknown[]) => string
type IsFinal = (refusal: AgentSessionRefusalReference | undefined) => boolean

let directory: string
const journals = createTrackedJournalOpener()

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-newer-chat-xv-'))
})

afterAll(async () => {
  await journals.closeAll()
  rmSync(directory, { recursive: true, force: true })
})

/** A function the checked-out build exports, typed as the caller calls it. */
function releaseExport<T>(module: Record<string, unknown>, name: string): T {
  const value = module[name]
  if (value === undefined) {
    throw new Error(`the checked-out build exports no ${name}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an export the checked-out build defines; each caller names the shape it uses, and a changed one fails the test.
  return value as T
}

/** A row of a kind this build does not know: the journal's open is refused as a newer Orca's. */
const NEWER_ROW_KIND = { kind: 'future-mark' }

async function journalWithNewerRow(): Promise<void> {
  const journal = await journals.open({ identity: IDENTITY, stateDirectory: directory })
  await journal.appendItem(
    { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 },
    { kind: 'status', text: 'before' },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await journal.appendItem(
    { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 2 },
    { kind: 'status', text: 'also before' },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  const seq = journal.cursor().sequence + 1
  const newer = JSON.stringify({
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: journal.epoch,
    seq,
    fence: 1,
    ts: 2_000,
    ...NEWER_ROW_KIND
  })
  await journals.closeAll()
  insertTestJournalRowJson(
    openTestJournalHostDatabase(directory).db,
    IDENTITY.sessionId,
    seq,
    newer,
    2_000
  )
  closeTestJournalHostDatabase(directory)
}

/** This host's refusal of a newer Orca's chat, as `history` and `subscribe` raise it. */
async function newerChatRefusal(): Promise<AgentSessionRefusalReference> {
  await journalWithNewerRow()
  const failure = await journals.open({ identity: IDENTITY, stateDirectory: directory }).then(
    () => null,
    (error: unknown) => error
  )
  expect(failure).toMatchObject(SAVED_BY_NEWER_ORCA)
  await journals.closeAll()
  return journalOpenRefusal(failure)
}

/** How a released client words a read refusal, and whether it stops retrying on it. */
async function releasedReader(ref: string) {
  const checkout = await materializeReleaseCheckout(ref)
  const notice = await importReleaseCheckoutModule(
    checkout,
    'src/shared/agent-session-refusal-notice.ts'
  )
  const readRefusal = await importReleaseCheckoutModule(
    checkout,
    'src/shared/structured-agent-session-read-refusal.ts'
  )
  const parts = releaseExport<ReadHistoryParts>(notice, 'agentSessionReadHistoryRefusalParts')
  const english = releaseExport<NoticeEnglish>(notice, 'agentSessionWriteNoticeEnglish')
  const isFinal = releaseExport<IsFinal>(readRefusal, 'isFinalAgentSessionReadRefusal')
  // The pane's own Retry stands beside the words, as on desktop.
  const words = (refusal: Pick<AgentSessionRefusalReference, 'code' | 'details'>) =>
    english(parts(refusal.code, refusal.details, { retryControl: true }))
  return { words, isFinal }
}

describe('a chat a newer Orca saved, across versions', () => {
  it(
    'old client against new host: a release before the reason words it as an unreadable history and keeps retrying',
    async () => {
      const refusal = await newerChatRefusal()
      const released = await releasedReader(BEFORE_NEWER_REASON_REF)
      const code = { code: refusal.code }
      const damage = { code: refusal.code, details: { reason: 'journalCorrupt' } }
      expect(released.words(refusal)).toBe(released.words(code))
      expect(released.words(refusal)).not.toBe(released.words(damage))
      expect(released.isFinal(refusal)).toBe(false)
    },
    SUITE_TIMEOUT_MS
  )

  it(
    'old client against new host: the newest release words it as its own, never as damage',
    async () => {
      rmSync(directory, { recursive: true, force: true })
      directory = mkdtempSync(join(tmpdir(), 'orca-newer-chat-xv-'))
      const refusal = await newerChatRefusal()
      const released = await releasedReader(resolveBaselineReleaseRef())
      const damage = { code: refusal.code, details: { reason: 'journalCorrupt' } }
      expect(released.words(refusal)).not.toBe('')
      expect(released.words(refusal)).not.toBe(released.words(damage))
    },
    SUITE_TIMEOUT_MS
  )
})
