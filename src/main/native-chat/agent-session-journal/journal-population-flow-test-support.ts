import { exerciseSharedLegacyPopulation } from './journal-population-shared-legacy-test-support'
import { exercisePopulationQueue } from './journal-population-queue-test-support'
import { exerciseRetainedPopulation } from './journal-population-retained-test-support'
import { assertJournalPopulationBounds } from './journal-population-bounds-test-support'
import { serialize } from 'node:v8'
import { populationState, populationWriter } from './journal-population-owner-test-support'
import { expect } from 'vitest'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { structuredAgentSessionCommandTurnIdentity } from '../../../shared/structured-agent-session-command-turn-identity'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { openAgentSessionJournal } from './journal-store-factory'
import type { AgentSessionJournal } from './journal-store'
import type { JournalSubmissionRow } from './journal-row-schema'
import { buildJournalQueueRow } from './journal-queue-events'
import { JournalMutationMap } from './journal-mutation-map'
import { exercisePopulationSelection } from './journal-population-selection-test-support'
import { exercisePopulationRetirement } from './journal-population-retirement-test-support'
import { exercisePopulationWork } from './journal-population-work-test-support'
import { runLegacyPopulation } from './journal-population-legacy-test-support'
import { openTestJournalHostDatabase } from './journal-host-database-test-support'
import { readJournalRestFacts } from './journal-row-table'
import {
  JournalPopulationMeter,
  type PopulationCost
} from './journal-population-meter-test-support'
import { runPopulationUpgrade } from './journal-population-upgrade-test-support'

const turnIdentity = (id: string) =>
  ({ provider: 'codex', threadId: 'population-thread', turnId: id, ordinal: 0 }) as const
const text: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'shared accepted input' }]
}
const command: AgentJournalMessageItem = { ...text, command: { name: 'compact' } }

export type PopulationReceipt = {
  count: number
  phases: Record<string, PopulationCost>
  rows: number
  checkpointReads: number
  cleanupRows: number
}

/** One complete scenario, invoked only by the existing work-index contract caller. */
export async function runJournalPopulationContract(
  root: string,
  count: number
): Promise<PopulationReceipt> {
  const meter = new JournalPopulationMeter()
  const phases: Record<string, PopulationCost> = {}
  let journal: AgentSessionJournal | undefined
  const clock = 100
  const sessionId = `population-${count}`
  const database = openTestJournalHostDatabase(root)
  const open = () =>
    openAgentSessionJournal({
      identity: {
        sessionId,
        workspaceId: 'workspace',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle('population-thread')
      },
      database,
      now: () => clock
    })
  const measure = async <T>(name: string, run: () => T | Promise<T>): Promise<T> => {
    const result = await meter.measure(run)
    phases[name] = result.cost
    return result.value
  }
  try {
    journal = await measure('open', open)
    const current = journal
    const state = populationState(current)
    const writer = populationWriter(current)
    meter.label(state)
    const publications: { sequence: number; pair: unknown; rows: number }[] = []
    current.observeCommits((rows) => {
      publications.push({
        sequence: current.cursor().sequence,
        pair: readJournalRestFacts(database.db, sessionId),
        rows: rows?.length ?? 0
      })
    })
    const fingerprint = agentSessionSendBodyFingerprint(sessionId, text)
    const submission = (raw: string, at: number, queuedMessageId?: string) =>
      writer.enqueue((seq): JournalSubmissionRow => ({
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        kind: 'submission',
        epoch: state.epoch,
        seq,
        ts: at,
        fence: 1,
        providerHandle: codexProviderHandle('population-thread'),
        clientMessageId: raw,
        body: text,
        payloadFingerprint: fingerprint,
        handoverRecorded: true,
        ...(queuedMessageId === undefined ? {} : { queuedMessageId })
      }))
    const queue = (id: string, attempt: string, position: number, body = command) =>
      writer.enqueue((seq, ts) =>
        buildJournalQueueRow(
          state,
          id,
          {
            op: 'queued',
            body,
            position,
            queuedAt: null,
            attempt,
            returned: { reason: 'recorded refusal' }
          },
          seq,
          ts
        )
      )
    const status = (id: string) =>
      current.appendItem(turnIdentity(id), { kind: 'status', text: id }, { fence: 1 })
    await measure('construction', async () => {
      for (let index = 0; index < count; index++) {
        await submission(`echo-${index}`, 100 + count - index)
        await current.appendItem(
          turnIdentity(`root-${index}`),
          {
            kind: 'turn',
            turnId: `root-${index}`,
            state: 'running',
            startedAt: 200 + index,
            userItemId: agentJournalSubmissionKey(`echo-${index}`)
          },
          { fence: 1 }
        )
        await current.appendItem(
          turnIdentity(`cut-${index}`),
          {
            kind: 'turn',
            turnId: `cut-${index}`,
            state: 'interrupted',
            outcome: 'cancellation',
            startedAt: 300 + index
          },
          { fence: 1 }
        )
        await queue(`group-card-${index}`, 'shared-report', index + 1)
        await queue(`other-card-${index}`, `absent-${index}`, count + index + 1, text)
        await current.appendSubmission({
          clientMessageId: `alias-source-${index}`,
          payloadFingerprint: `alias-${index}`,
          body: text,
          fence: 1,
          handoverRecorded: true
        })
        await current.resolveDispatch({
          clientMessageId: `alias-source-${index}`,
          fence: 1,
          state: 'accepted',
          providerIdentity: turnIdentity(`alias-${index}`)
        })
        await current.appendTombstone(turnIdentity(`absent-item-${index}`), { fence: 1 })
      }
    })
    expect(state.submissions.size).toBe(2 * count)
    expect(state.queue.cards.size).toBe(2 * count)
    expect(
      state.selection.groups.has(
        `report:${agentJournalItemKey(structuredAgentSessionCommandTurnIdentity('shared-report'))}`
      )
    ).toBe(true)
    expect(state.aliases.size).toBe(count)
    expect(state.tombstones.size).toBeGreaterThanOrEqual(count)
    expect(state.selection.tree.heightOf(`echo:${fingerprint}`)).toBeLessThanOrEqual(
      2 * Math.ceil(Math.log2(count + 1))
    )
    const initialQueueRevision = state.queue.revision
    await measure('unrelated', () => status('unrelated-fixed'))
    for (const name of [
      'items',
      'submissions',
      'aliases',
      'cards',
      'workEntries',
      'rest:requests',
      'rest:clears',
      'groupMembers',
      'treeNodes'
    ]) {
      expect(phases.unrelated.namespaces[name]?.iterated ?? 0).toBe(0)
    }
    expect(state.queue.revision).toBe(initialQueueRevision)
    await measure('unrelated-series', async () => {
      for (let index = 0; index < count; index++) {
        await status(`unrelated-${index}`)
      }
    })
    // The baseline oracle uses native key lifetimes, including a read-only COW touch.
    const native = new Map([
      ['A', 1],
      ['B', 2]
    ])
    const staged = new JournalMutationMap(native, (value) => value)
    expect(staged.get('A')).toBe(1)
    staged.set('A', 3)
    expect([...staged.keys()]).toEqual(['A', 'B'])
    native.delete('A')
    native.set('A', 4)
    const detached = new JournalMutationMap(
      new Map([
        ['A', 1],
        ['B', 2]
      ])
    )
    detached.delete('A')
    detached.set('A', 4)
    expect([...detached]).toEqual([...native])
    await measure('staged-selection-boundaries', () => exercisePopulationSelection(state))
    await measure('work-dependencies', () => exercisePopulationWork(current, count))
    const rawBefore = state.selection.echo(fingerprint)
    expect(rawBefore).toBe(`echo-${count - 1}`)
    const sources = state.selection.storage.map<string, { ordinal: number; signature: string }>(
      'submissionSources'
    )
    const sourceBefore = sources.get(rawBefore!)!
    const capturedSource = serialize(sourceBefore)
    await current.resolveDispatch({
      clientMessageId: rawBefore!,
      fence: 1,
      state: 'pending',
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    expect(state.selection.echo(fingerprint)).toBe(rawBefore)
    expect(sources.get(rawBefore!)?.ordinal).toBe(sourceBefore.ordinal)
    expect(sources.get(rawBefore!)).not.toBe(sourceBefore)
    expect(serialize(sourceBefore)).toEqual(capturedSource)

    await measure('context-and-echo', async () => {
      const noOutput = state.selection.tree.candidate(`echo:${fingerprint}`, rawBefore!)
      for (let index = 0; index < count; index++) {
        const clear = turnIdentity(`clear-${index}`)
        await current.appendItem(
          clear,
          {
            kind: 'status',
            text: 'clear',
            contextClear: { operationId: `clear-${index}`, afterFence: 1, clearedAt: 500 + index }
          },
          { fence: 1 }
        )
        expect(state.selection.echo(fingerprint)).toBeUndefined()
        await current.appendTombstone(clear, { fence: 1 })
        expect(state.selection.echo(fingerprint)).toBe(rawBefore)
        expect(state.selection.tree.candidate(`echo:${fingerprint}`, rawBefore!)).toEqual(noOutput)
      }
    })
    // Falling floors expose dormant echo choices, but do not resurrect removed work.
    expect(current.restFact()).toBeNull()
    await exerciseRetainedPopulation(current, count, measure)
    const blockedEcho = { ...turnIdentity('compound-blocked-echo'), ordinal: 1 }
    const liveClear = turnIdentity('compound-live-clear')
    await current.appendLifecycleBatch({
      settlementId: 'clear-before-echo',
      fence: 1,
      mutations: [
        {
          kind: 'item',
          identity: liveClear,
          body: {
            kind: 'status',
            text: 'clear',
            contextClear: { operationId: 'live-clear', afterFence: 1, clearedAt: 599 }
          }
        },
        { kind: 'item', identity: blockedEcho, body: text }
      ]
    })
    expect(state.aliases.has(agentJournalItemKey(blockedEcho))).toBe(false)
    expect(state.selection.contextFloor()).toBe(state.rest.checkpoint().floor)
    await current.appendTombstone(liveClear, { fence: 1 })
    const compoundEcho = { ...turnIdentity('compound-context-echo'), ordinal: 1 }
    const compoundClear = turnIdentity('compound-current-context')
    await current.appendLifecycleBatch({
      settlementId: 'two-context-source-positions',
      fence: 1,
      mutations: [
        {
          kind: 'item',
          identity: compoundClear,
          body: {
            kind: 'status',
            text: 'clear',
            contextClear: { operationId: 'compound-clear', afterFence: 1, clearedAt: 600 }
          }
        },
        { kind: 'tombstone', identity: compoundClear },
        { kind: 'item', identity: compoundEcho, body: text }
      ]
    })
    expect(state.aliases.get(agentJournalItemKey(compoundEcho))).toBe(
      agentJournalSubmissionKey(rawBefore!)
    )
    const nextRaw = state.selection.echo(fingerprint)!
    const echoIdentity = { ...turnIdentity('actual-echo'), ordinal: 1 }
    await current.appendItem(echoIdentity, text, { fence: 1 })
    expect(current.submission(nextRaw)?.providerItemId).toBe(agentJournalItemKey(echoIdentity))
    const explicitNull = { ...turnIdentity('explicit-null'), ordinal: 1 }
    await current.appendItem(explicitNull, text, { fence: 1, echoOf: null })
    expect(state.aliases.has(agentJournalItemKey(explicitNull))).toBe(false)

    await exercisePopulationQueue({
      current,
      state,
      writer,
      database,
      count,
      text,
      command,
      publications,
      measure,
      queue,
      status
    })

    const raw = await exercisePopulationRetirement(current, root, submission, publications, measure)

    await runLegacyPopulation(current, root, count, measure, status)
    await exerciseSharedLegacyPopulation(root, count, measure)
    // Retain a genuine many-member flush at the last row for an interior checkpoint.
    for (let index = 0; index < 4 * count; index++) {
      await queue(`resume-card-${index}`, 'resume-report', 10 * count + index)
    }
    const beforeResumeQueue = state.queue.revision
    await current.appendItem(
      structuredAgentSessionCommandTurnIdentity('resume-report'),
      {
        kind: 'turn',
        turnId: 'resume-report',
        state: 'completed',
        outcome: 'failure'
      },
      { fence: 1 }
    )
    const expected = current.restFact()
    const tip = current.cursor().sequence
    const rawSnapshot = current.snapshot()
    await current.close()
    journal = undefined
    const upgrade = await measure('structural-resume-cleanup', () =>
      runPopulationUpgrade(root, sessionId, tip, expected, beforeResumeQueue, 4 * count)
    )
    expect(readJournalRestFacts(database.db, sessionId)?.openTurn).toEqual(expected)
    journal = await measure('reopen', open)
    expect(journal.snapshot()).toEqual(rawSnapshot)
    expect(journal.restFact()).toEqual(expected)
    expect(journal.submission(raw)?.clientMessageId).toBe(raw)
    assertJournalPopulationBounds(database, sessionId, count, tip, phases, upgrade)
    return {
      count,
      phases,
      rows: tip,
      checkpointReads: upgrade.reads,
      cleanupRows: upgrade.cleanupRows
    }
  } finally {
    await journal?.close()
    meter.close()
  }
}
