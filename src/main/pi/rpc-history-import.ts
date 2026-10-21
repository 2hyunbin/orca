import { createHash } from 'node:crypto'
import { z } from 'zod'
import { agentSessionHostStatusBody } from '../../shared/agent-session-host-status-rows'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import {
  CODEX_RESTORE_MAX_BYTES,
  CODEX_RESTORE_MAX_OPERATIONS
} from '../codex/codex-structured-journal-translation-restore'
import {
  LEGACY_IMPORT_BLOCK_LIMITS,
  legacyItemBody
} from '../native-chat/agent-session-journal/journal-legacy-import'
import { decodePiSessionEntryLine } from '../native-chat/agent-session-journal/journal-pi-active-branch'
import {
  journalLifecycleItemMutation,
  type JournalLifecycleMutationInput
} from '../native-chat/agent-session-journal/journal-row-builders'
import type { StructuredAgentSessionTransitionJournal } from '../native-chat/agent-session-wire/structured-agent-session-transition'

const piEntrySchema = z.looseObject({
  id: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  type: z.string()
})
export type PiSessionEntry = z.infer<typeof piEntrySchema>

/** `get_entries`: the entries after `since` in the order Pi appended them, and its leaf. */
export const piEntriesAnswerSchema = z.object({
  entries: z.array(piEntrySchema),
  leafId: z.string().min(1).nullable()
})
export type PiEntriesAnswer = z.infer<typeof piEntriesAnswerSchema>

/** The answer to `get_entries since: claim`: the active branch after the claim, oldest first, when
 *  the leaf's `parentId` chain reaches the claim inside it; null when the terminal went back to an
 *  earlier point, which only the whole tree can place. The answer lists in append order and keeps
 *  abandoned branches, so the branch is always walked from the leaf. */
export function piBranchSince(
  answer: PiEntriesAnswer,
  claim: string
): { path: PiSessionEntry[]; rewound: false } | null {
  const walked = walkFromLeaf(answer, (id) => id === claim)
  return walked?.stop === claim ? { path: walked.path, rewound: false } : null
}

/**
 * The whole tree's active branch after the newest entry the chat accounts for: the claim, or the
 * nearest of its ancestors where the terminal branched off (rewound). Without a claim, the whole
 * branch. 'unknown-claim' when the claim isn't in this conversation at all.
 */
export function piBranchInTree(
  answer: PiEntriesAnswer,
  claim: string | null
): { path: PiSessionEntry[]; rewound: boolean } | 'unknown-claim' | null {
  const byId = new Map(answer.entries.map((entry) => [entry.id, entry]))
  const accounted = new Set<string>()
  for (let id = claim; id !== null && !accounted.has(id); id = byId.get(id)?.parentId ?? null) {
    if (!byId.has(id)) {
      return 'unknown-claim'
    }
    accounted.add(id)
  }
  const walked = walkFromLeaf(answer, (id) => accounted.has(id))
  if (!walked || (walked.stop === null) !== (claim === null)) {
    return null
  }
  return { path: walked.path, rewound: walked.stop !== claim }
}

function walkFromLeaf(
  answer: PiEntriesAnswer,
  stopsAt: (id: string) => boolean
): { path: PiSessionEntry[]; stop: string | null } | null {
  const byId = new Map(answer.entries.map((entry) => [entry.id, entry]))
  const path: PiSessionEntry[] = []
  let current = answer.leafId
  while (current !== null && !stopsAt(current)) {
    const entry = byId.get(current)
    if (!entry) {
      return null
    }
    // Each id is visited once: a cycle ends the walk as incomplete history.
    byId.delete(current)
    path.push(entry)
    current = entry.parentId
  }
  return { path: path.toReversed(), stop: current }
}

/** Rows keyed as adoption keys them (`legacy/pi/<session file>/<entry id>`), so both dedupe. */
export function piHistoryEntryIdentity(
  sessionFile: string,
  entryId: string
): AgentJournalItemIdentity {
  return { provider: 'legacy', agent: 'pi', sessionId: sessionFile, recordId: entryId }
}

/** Outside entries as journal rows, staged whole before anything is written; entries the journal
 *  already holds are left out first, so an earlier import never vetoes newer entries. */
export function createPiHistoryImportPlan(input: {
  sessionFile: string
  journal: StructuredAgentSessionTransitionJournal
  path: readonly PiSessionEntry[]
  rewound: boolean
  /** Only a chat that already shows something needs the divider. */
  divider: boolean
  check: () => void
}) {
  const mutations: JournalLifecycleMutationInput[] = []
  const keys: string[] = []
  let bytes = 0
  const push = (
    mutation: JournalLifecycleMutationInput & { identity: AgentJournalItemIdentity }
  ) => {
    input.check()
    bytes += Buffer.byteLength(JSON.stringify(mutation), 'utf8') + 1
    if (mutations.length >= CODEX_RESTORE_MAX_OPERATIONS || bytes > CODEX_RESTORE_MAX_BYTES) {
      throw new Error('too-large')
    }
    mutations.push(mutation)
    keys.push(agentJournalItemKey(mutation.identity))
  }
  const entryIds: string[] = []
  for (const entry of input.path) {
    const identity = piHistoryEntryIdentity(input.sessionFile, entry.id)
    const key = agentJournalItemKey(identity)
    if (input.journal.item(input.journal.canonicalItemId(key)) !== null) {
      continue
    }
    const message = decodePiSessionEntryLine(JSON.stringify(entry), entry.id)
    if (!message) {
      continue
    }
    const body = legacyItemBody(message, LEGACY_IMPORT_BLOCK_LIMITS)
    if (entryIds.length === 0 && input.divider) {
      push(
        journalLifecycleItemMutation(
          { turnScope: AGENT_JOURNAL_THREAD_SCOPE },
          piHistoryEntryIdentity(input.sessionFile, `continued-outside:${entry.id}`),
          agentSessionHostStatusBody(
            input.rewound ? 'continued-outside-rewound' : 'continued-outside'
          )
        )
      )
    }
    // Imported prompts are history, never sends delivery recovery could claim.
    push(
      journalLifecycleItemMutation(
        {
          turnScope: AGENT_JOURNAL_THREAD_SCOPE,
          ...(body.kind === 'message' && body.role === 'user' ? { echoOf: null } : {})
        },
        identity,
        body
      )
    )
    entryIds.push(entry.id)
  }
  const digest = createHash('sha256')
    .update(JSON.stringify([input.journal.epoch, input.sessionFile, entryIds]))
    .digest('hex')
  const settlementId = `pi-history-import:${digest}`
  // Match the existing batch envelope charge, plus the transition's one publication byte.
  const reservedBytes = Buffer.byteLength(JSON.stringify({ settlementId, mutations }), 'utf8') + 512
  if (reservedBytes + 1 > CODEX_RESTORE_MAX_BYTES) {
    throw new Error('too-large')
  }
  return { settlementId, mutations, keys, entryIds, reservedBytes }
}
