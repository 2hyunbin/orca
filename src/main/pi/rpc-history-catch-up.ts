import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { JsonlRpcResponseError } from '../jsonl-rpc/peer'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import {
  createPiHistoryImportPlan,
  piBranchInTree,
  piBranchSince,
  piEntriesAnswerSchema,
  type PiEntriesAnswer
} from './rpc-history-import'
import {
  readPiHistoryJournalView,
  samePiHistoryJournalView,
  usablePiHistoryClaim,
  type PiHistoryClaim
} from './rpc-history-journal-view'
import type { PiRpcConnection } from './rpc-session'
import { readPiSessionLastEntryId } from './rpc-session-file-tail'

export const PI_HISTORY_CATCH_UP_TIMEOUT_MS = 30_000

/** What a catch-up leaves the chat with: the claim to save on this open's link, and whether it
 *  names Pi's current leaf (a capture may then continue from it) or was only carried forward. */
export type PiHistoryCatchUp = { claim: PiHistoryClaim | null; current: boolean }

/** `get_entries`, whose oversized answer fails only this read. */
export async function readPiEntries(
  connection: Pick<PiRpcConnection, 'request'>,
  since: string | null,
  timeoutMs?: number
): Promise<PiEntriesAnswer> {
  return piEntriesAnswerSchema.parse(
    await connection.request('get_entries', since === null ? {} : { since }, {
      oversizedReply: 'reject',
      ...(timeoutMs === undefined ? {} : { timeoutMs })
    })
  )
}

// Pi has no writer lock: a terminal can write the conversation only while the chat's Pi isn't
// running, and every start of the chat's Pi opens here, with Pi's view freshly loaded from disk.

/** Optional reconciliation never gates the open; a failure keeps the claim the chat already had. */
export async function catchUpPiSession(input: {
  connection: Pick<PiRpcConnection, 'request'>
  sessionId: string
  sessionFile: string
  /** Every file of this conversation: entries keep their ids across a directory fork. */
  lineage: ReadonlySet<string>
  claim: PiHistoryClaim | null
  sink: StructuredAgentSessionEventSink | undefined
  signal: AbortSignal
  assertCurrent: () => void
  timeoutMs?: number
  logger: StructuredAgentSessionLogger
}): Promise<PiHistoryCatchUp> {
  const carried: PiHistoryCatchUp = { claim: input.claim, current: false }
  const controller = new AbortController()
  const abort = () => controller.abort(input.signal.reason)
  input.signal.addEventListener('abort', abort, { once: true })
  if (input.signal.aborted) {
    abort()
  }
  const timeoutMs = input.timeoutMs ?? PI_HISTORY_CATCH_UP_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  const timer = setTimeout(() => controller.abort(new Error('catch-up-deadline')), timeoutMs)
  const check = () => {
    if (controller.signal.aborted || Date.now() >= deadline) {
      throw new Error('catch-up-cancelled')
    }
    input.assertCurrent()
  }
  const warn = (reason: string, error?: unknown) =>
    input.logger.warn('Pi chat did not catch up on turns made outside it', {
      scope: 'pi-history-catch-up',
      sessionId: input.sessionId,
      reason,
      ...(error === undefined ? {} : { error })
    })
  const read = async (since: string | null) => {
    check()
    const answer = await waitForPromiseWithSignal(
      readPiEntries(input.connection, since, Math.max(1, deadline - Date.now())),
      controller.signal
    )
    check()
    return answer
  }
  const sink = input.sink
  try {
    check()
    const written = await waitForPromiseWithSignal(
      sink?.written?.() ?? Promise.resolve({ ok: true }),
      controller.signal
    )
    check()
    const history = sink?.journalHistory?.()
    const journal = sink?.journalItems?.()
    if (!sink?.tryAppendTransition || !history || !journal || !written.ok) {
      return carried
    }
    const view = readPiHistoryJournalView(history, input.lineage)
    const claim = usablePiHistoryClaim(input.claim, view)
    const claimAt = (entry: string | null): PiHistoryCatchUp => {
      const cursor = history.cursor()
      return {
        claim: entry === null ? null : { entry, epoch: cursor.epoch, sequence: cursor.sequence },
        current: true
      }
    }
    // The chat's own work after the claim and the terminal's share one suffix nothing can split.
    // Without a claim, any Pi history the journal already shows (adopted, or an older build's
    // turns) leaves nothing to split it by.
    const known = view.ownWorkSequence > 0 || view.accounted.size > 0
    if (claim ? view.ownWorkSequence > claim.sequence : known) {
      return claimAt(await currentLeaf(input.sessionFile, read))
    }
    let answer = claim ? await readSince(read, claim.entry) : null
    let branch = answer && claim ? piBranchSince(answer, claim.entry) : null
    if (!branch) {
      answer = await read(null)
      const inTree = piBranchInTree(answer, claim?.entry ?? null)
      if (inTree === 'unknown-claim') {
        return claimAt(answer.leafId)
      }
      if (!inTree) {
        warn('incomplete-history')
        return carried
      }
      branch = inTree
    }
    const leaf = answer?.leafId ?? null
    const plan = createPiHistoryImportPlan({
      sessionFile: input.sessionFile,
      journal,
      path: branch.path.filter((entry) => !view.accounted.has(entry.id)),
      rewound: branch.rewound,
      divider: view.hasRows,
      check
    })
    if (plan.mutations.length === 0) {
      return claimAt(leaf)
    }
    let resolved = false
    const admission = sink.tryAppendTransition({
      lifecycle: true,
      publish: true,
      steps: [
        {
          kind: 'settlement',
          settlementId: plan.settlementId,
          reservedBytes: plan.reservedBytes,
          resolve: (current) => {
            try {
              check()
            } catch {
              return []
            }
            if (
              current.epoch !== view.epoch ||
              sink.journalHistory?.() !== history ||
              !samePiHistoryJournalView(view, readPiHistoryJournalView(history, input.lineage))
            ) {
              return []
            }
            if (plan.keys.some((key) => current.item(current.canonicalItemId(key)) !== null)) {
              return []
            }
            // Canonical keys can also collide with one another through an existing submission alias.
            if (
              new Set(plan.keys.map((key) => current.canonicalItemId(key))).size !==
              plan.keys.length
            ) {
              return []
            }
            resolved = true
            return plan.mutations
          }
        }
      ]
    })
    if (!admission.accepted) {
      warn(admission.reason)
      return carried
    }
    const committed = await sink.written?.()
    if (committed?.ok === false) {
      warn('write-failed', committed.error)
      return carried
    }
    if (!resolved) {
      warn('stale-history')
      return carried
    }
    return claimAt(leaf)
  } catch (error) {
    warn('import-skipped', error)
    return carried
  } finally {
    clearTimeout(timer)
    input.signal.removeEventListener('abort', abort)
  }
}

/** A claim Pi no longer has (a replaced file) answers as if the whole tree had to be read. */
async function readSince(
  read: (since: string | null) => Promise<PiEntriesAnswer>,
  entry: string
): Promise<PiEntriesAnswer | null> {
  try {
    return await read(entry)
  } catch (error) {
    if (error instanceof JsonlRpcResponseError && error.message.startsWith('Entry not found')) {
      return null
    }
    throw error
  }
}

/** Pi's leaf, asked cheaply after the file's last entry when the file still matches what Pi
 *  loaded, else from the whole tree. */
async function currentLeaf(
  sessionFile: string,
  read: (since: string | null) => Promise<PiEntriesAnswer>
): Promise<string | null> {
  const last = await readPiSessionLastEntryId(sessionFile).catch(() => null)
  const hinted = last === null ? null : await readSince(read, last)
  return (hinted ?? (await read(null))).leafId
}
