import { legacyRestScratchPath } from './journal-legacy-rest-scratch'
import { assertPopulationQueryPlans } from './journal-population-query-plan-test-support'
import { serialize } from 'node:v8'
import { expect, vi } from 'vitest'
import type { JournalRestFacts } from './journal-row-table'
import { readJournalRestFacts } from './journal-row-table'
import { openTestJournalHostDatabase } from './journal-host-database-test-support'
import { JournalLegacyRestInitializer } from './journal-legacy-rest-initializer'
import {
  JournalStructuralScratch,
  type JournalStructuralCheckpoint
} from './journal-structural-scratch'

/** Actual initializer, independent committed reader, inner-row resume and bounded teardown. */
export async function runPopulationUpgrade(
  root: string,
  sessionId: string,
  tip: number,
  expected: JournalRestFacts['openTurn'],
  queueBeforeFlush: number,
  flushOutputs: number
): Promise<{ cleanupSteps: number; reads: number; cleanupRows: number; checkpoints: number }> {
  const database = openTestJournalHostDatabase(root)
  const path = legacyRestScratchPath(root, sessionId)
  const publications: JournalRestFacts[] = []
  const errors: unknown[] = []
  let owner: string | null = 'population-ended-owner'
  let reader = new JournalStructuralScratch(path)
  const initializers: JournalLegacyRestInitializer[] = []
  const make = () => {
    const initializer = new JournalLegacyRestInitializer({
      database,
      candidates: () => [sessionId],
      owner: () => owner,
      initialized: (_id, facts) => {
        publications.push(facts)
      },
      failed: (_id, error) => {
        errors.push(error)
      }
    })
    initializers.push(initializer)
    return initializer
  }
  const unknown = () =>
    database.db
      .prepare(`UPDATE journal_sessions
    SET open_turn_id = NULL, open_turn_since = NULL WHERE session_id = ?`)
      .run(sessionId)
  const saved = () => reader.load<JournalStructuralCheckpoint>()
  const statementSpies: { mockRestore(): void }[] = []
  let failNextSave = false
  let checkpoints = 0
  let reads = 0
  let cleanupSteps = 0
  const afterSequences: number[] = []
  const save = JournalStructuralScratch.prototype.save
  const saveSpy = vi
    .spyOn(JournalStructuralScratch.prototype, 'save')
    .mockImplementation(function (value) {
      checkpoints++
      const result = save.call(this, value)
      if (failNextSave) {
        failNextSave = false
        throw new Error('population scratch after-save rollback')
      }
      return result
    })
  const prepare = database.db.prepare.bind(database.db)
  const statements = new WeakSet<object>()
  const sql = vi.spyOn(database.db, 'prepare').mockImplementation((query) => {
    const statement = prepare(query)
    if (query.includes('ORDER BY seq ASC LIMIT') && !statements.has(statement)) {
      statements.add(statement)
      const all = statement.all.bind(statement)
      statementSpies.push(
        vi.spyOn(statement, 'all').mockImplementation((...args) => {
          reads++
          afterSequences.push(Number(args[2]))
          return all(...args)
        })
      )
    }
    return statement
  })
  const cleanup = JournalStructuralScratch.prototype.cleanupStep
  const cleanupSpy = vi
    .spyOn(JournalStructuralScratch.prototype, 'cleanupStep')
    .mockImplementation(function (limit, canWork) {
      cleanupSteps++
      return cleanup.call(this, limit, canWork)
    })
  try {
    unknown()
    const prefix = make()
    await prefix.advance(() => {
      const checkpoint = saved()
      return !(
        checkpoint?.pending?.sequence === tip &&
        checkpoint.pending.phase === 'queue' &&
        (checkpoint.queueRevision ?? 0) > queueBeforeFlush &&
        (checkpoint.queueRevision ?? 0) < queueBeforeFlush + flushOutputs
      )
    })
    await prefix.close()
    const interior = saved()!
    expect(interior.pending?.sequence).toBe(tip)
    expect(interior.pending?.phase).toBe('queue')
    expect(interior.cursor).toBe(tip - 1)
    expect(interior.cursor).toBeGreaterThan(0)
    expect(interior.queueRevision).toBeGreaterThan(queueBeforeFlush)
    expect(interior.queueRevision).toBeLessThan(queueBeforeFlush + flushOutputs)
    expect(reader.map('items').size).toBeGreaterThan(0)
    expect(readJournalRestFacts(database.db, sessionId)?.known).toBe(false)
    expect(publications).toEqual([])
    const relationSnapshot = serialize(Array.from(reader.map('selection:treeNodes')))
    const memberSnapshot = serialize(Array.from(reader.map('selection:groupMembers')))
    const sourceSnapshot = serialize(Array.from(reader.map('selection:submissionSources')))
    const checkpointBytes = serialize(interior)
    reader.close()
    reader = new JournalStructuralScratch(path)
    expect(serialize(saved())).toEqual(checkpointBytes)
    expect(serialize(Array.from(reader.map('selection:treeNodes')))).toEqual(relationSnapshot)

    const originalRow = database.db
      .prepare('SELECT row_json AS source FROM journal_rows WHERE session_id = ? AND seq = ?')
      .get(sessionId, tip)?.source
    if (typeof originalRow !== 'string') {
      throw new Error('missing real pending source row')
    }
    database.db
      .prepare(`UPDATE journal_rows SET row_json = json_set(row_json, '$.body.outcome', 'success')
      WHERE session_id = ? AND seq = ?`)
      .run(sessionId, tip)
    const changedSource = make()
    await changedSource.advance(() => true)
    await changedSource.close()
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain('pending journal source changed')
    expect(publications).toEqual([])
    expect(serialize(saved())).toEqual(checkpointBytes)
    expect(serialize(Array.from(reader.map('selection:treeNodes')))).toEqual(relationSnapshot)
    database.db
      .prepare('UPDATE journal_rows SET row_json = ? WHERE session_id = ? AND seq = ?')
      .run(originalRow, sessionId, tip)

    const beforePauseReads = reads
    const paused = make()
    await paused.advance(() => false)
    await paused.close()
    expect(reads).toBe(beforePauseReads)
    expect(serialize(saved())).toEqual(checkpointBytes)
    owner = null
    const foreign = make()
    await foreign.advance(() => true)
    await foreign.close()
    expect(reads).toBe(beforePauseReads)
    expect(readJournalRestFacts(database.db, sessionId)?.known).toBe(false)
    owner = 'population-ended-owner'
    // Owner refusal retires incompatible progress; recreate the same committed source prefix
    // by a real initializer, rather than manufacturing selection state in a test double.
    if (!saved()?.pending) {
      const replacement = make()
      await replacement.advance(() => {
        const checkpoint = saved()
        return !(
          checkpoint?.pending?.sequence === tip &&
          checkpoint.pending.phase === 'queue' &&
          (checkpoint.queueRevision ?? 0) > queueBeforeFlush &&
          (checkpoint.queueRevision ?? 0) < queueBeforeFlush + flushOutputs
        )
      })
      await replacement.close()
    }
    const committed = saved()!
    const beforeFailure = serialize({
      checkpoint: committed,
      nodes: Array.from(reader.map('selection:treeNodes')),
      members: Array.from(reader.map('selection:groupMembers')),
      sources: Array.from(reader.map('selection:submissionSources'))
    })
    failNextSave = true
    const failed = make()
    await failed.advance(() => true)
    await failed.close()
    expect(errors).toHaveLength(2)
    expect(String(errors[1])).toContain('population scratch after-save rollback')
    expect(publications).toEqual([])
    expect(
      serialize({
        checkpoint: saved(),
        nodes: Array.from(reader.map('selection:treeNodes')),
        members: Array.from(reader.map('selection:groupMembers')),
        sources: Array.from(reader.map('selection:submissionSources'))
      })
    ).toEqual(beforeFailure)
    expect(readJournalRestFacts(database.db, sessionId)?.known).toBe(false)
    const resumeReads = reads
    const resumed = make()
    await resumed.advance(() => !reader.load<{ cleanup?: boolean }>()?.cleanup)
    await resumed.close()
    expect(afterSequences[resumeReads]).toBe(committed.cursor)
    expect(afterSequences.slice(resumeReads).every((cursor) => cursor >= committed.cursor)).toBe(
      true
    )
    expect(new Set(afterSequences.slice(resumeReads))).toEqual(new Set([tip - 1, tip]))
    expect(publications).toHaveLength(1)
    expect(publications[0]).toEqual(readJournalRestFacts(database.db, sessionId))
    expect(publications[0].openTurn).toEqual(expected)
    expect(reader.load<{ cleanup: boolean }>()?.cleanup).toBe(true)
    const beforeCleanup = Number(reader.db.prepare('SELECT COUNT(*) AS n FROM relations').get()?.n)
    const cleanupStepsBeforePause = cleanupSteps
    const firstCleanup = make()
    await firstCleanup.advance(() => cleanupSteps === cleanupStepsBeforePause)
    await firstCleanup.close()
    const afterCleanup = Number(reader.db.prepare('SELECT COUNT(*) AS n FROM relations').get()?.n)
    expect(beforeCleanup - afterCleanup).toBeGreaterThan(0)
    expect(beforeCleanup - afterCleanup).toBeLessThanOrEqual(32)
    expect(afterCleanup).toBeGreaterThan(0)
    expect(reader.load<{ cleanup: boolean }>()?.cleanup).toBe(true)
    reader.close()
    reader = new JournalStructuralScratch(path)
    const beforeRetirementReads = reads
    const retire = make()
    await retire.advance(() => true)
    await retire.close()
    expect(saved()).toBeUndefined()
    expect(reader.db.prepare('SELECT COUNT(*) AS n FROM relations').get()?.n).toBe(0)
    expect(reads).toBe(beforeRetirementReads)
    expect(publications).toHaveLength(1)
    assertPopulationQueryPlans(reader, database, sessionId)

    // Guard 5 is a disposable old format, never a reason to trust partial new relations.
    unknown()
    reader.map('obsolete-format-5').set('old-node', 'old-value')
    reader.save({
      ...committed,
      guard: JSON.stringify([5, ...JSON.parse(committed.guard).slice(1)])
    })
    const oldFormat = make()
    await oldFormat.advance(() => true)
    await oldFormat.close()
    expect(publications).toHaveLength(2)
    expect(publications[1].openTurn).toEqual(expected)
    expect(reader.map('obsolete-format-5').has('old-node')).toBe(false)
    const initializedReads = reads
    const initialized = make()
    await initialized.advance(() => true)
    await initialized.close()
    expect(reads).toBe(initializedReads)
    expect(errors).toHaveLength(2)
    expect(serialize(interior)).toEqual(checkpointBytes)
    expect(memberSnapshot.byteLength).toBeGreaterThan(0)
    expect(sourceSnapshot.byteLength).toBeGreaterThan(0)
    return { cleanupSteps, reads, checkpoints, cleanupRows: beforeCleanup }
  } finally {
    for (const initializer of initializers) {
      await initializer.close()
    }
    for (const spy of statementSpies) {
      spy.mockRestore()
    }
    cleanupSpy.mockRestore()
    sql.mockRestore()
    saveSpy.mockRestore()
    reader.close()
  }
}
