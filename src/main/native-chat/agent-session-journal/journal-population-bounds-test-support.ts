import { expect } from 'vitest'
import type { JournalHostDatabase } from './journal-host-database'
import type { PopulationCost } from './journal-population-cost-test-support'

type PhaseInput = { rows: number; outputs: number; lineage: number; diagnostic: number }

/** Inputs come from the scenario's source mutations and required outputs, never measured visits. */
export function assertJournalPopulationBounds(
  database: JournalHostDatabase,
  sessionId: string,
  count: number,
  tip: number,
  phases: Record<string, PopulationCost>,
  upgrade: { cleanupSteps: number; checkpoints: number; cleanupRows: number }
): void {
  const n = count
  const input = (rows: number, outputs = 0, lineage = 0, diagnostic = 0): PhaseInput => ({
    rows,
    outputs,
    lineage,
    diagnostic
  })
  const inputs: Record<string, PhaseInput> = {
    open: input(1),
    construction: input(8 * n, 0, 2 * n),
    unrelated: input(1),
    'unrelated-series': input(n),
    'staged-selection-boundaries': input(20, 0, 0, 4 * n),
    'work-dependencies': input(2 * n + 5, 0, 4 * n),
    'context-and-echo': input(2 * n, 0, 4 * n + 4),
    'request-seed': input(n + 4, 0, 4),
    'request-descending': input(n),
    'request-finished-rewind': input(5, 0, 6),
    'clear-seed': input(n + 1),
    'clear-nonmaximum': input(n),
    'clear-final': input(1),
    'final-presence': input(1, 0, 2),
    'queue-flush': input(1, n),
    'stale-trigger': input(1, 1),
    'duplicate-trigger': input(1, 1),
    retirement: input(1, 0, 2),
    'legacy-failed-import': input(n, n, n),
    'legacy-irrelevant': input(1),
    'legacy-import-retry': input(n, n, n),
    'shared-legacy-seed': input(n, 0, n, n),
    'shared-legacy-open': input(2 * n, n, n),
    'shared-legacy-point': input(1),
    'shared-legacy-series': input(n),
    'shared-legacy-noncommand-report': input(1),
    'shared-legacy-relevant-point': input(1, 1),
    'shared-legacy-relevant': input(n - 1, n - 1),
    // Three real corpus passes: initial prefix, owner-refusal restart, incompatible-format replay.
    // Snapshot/reopen assertions explicitly request nodes/members/source output and cleanup.
    'structural-resume-cleanup': input(3 * tip + 8, 12 * n, 12 * n, 32 * tip),
    reopen: input(tip, 8 * n, 4 * n, 8 * tip)
  }
  const height = 2 * Math.ceil(Math.log2(64 * n + 4097))
  const maximumRowBytes = Number(
    database.db
      .prepare(
        'SELECT MAX(length(CAST(row_json AS BLOB))) AS n FROM journal_rows WHERE session_id = ?'
      )
      .get(sessionId)?.n ?? 0
  )
  expect(maximumRowBytes).toBeGreaterThan(0)
  const noPopulationWalk = new Set([
    'construction',
    'unrelated',
    'unrelated-series',
    'work-dependencies',
    'context-and-echo',
    'request-seed',
    'request-descending',
    'request-finished-rewind',
    'clear-seed',
    'clear-nonmaximum',
    'clear-final',
    'shared-legacy-point',
    'shared-legacy-series',
    'shared-legacy-noncommand-report'
  ])
  const forbidden =
    /^(items|submissions|aliases|cards|workEntries|rest:requests|rest:clears|treeNodes|groupMembers)$/
  for (const [name, cost] of Object.entries(phases)) {
    const phase = inputs[name]
    expect(phase, `unpriced phase ${name}`).toBeDefined()
    const units = phase.rows + phase.outputs + phase.lineage + phase.diagnostic
    // Two folds, source hooks and AVL/heap paths; indexed SQL adds its B-tree cost, not VM steps.
    expect(cost.points).toBeLessThanOrEqual(4096 + 32768 * units * height)
    expect(cost.sqlCalls).toBeLessThanOrEqual(128 + 8192 * units * height)
    expect(cost.sqlRows).toBeLessThanOrEqual(128 + 8192 * units * height)
    expect(cost.constructors).toBeLessThanOrEqual(512 * (units + 1))
    expect(cost.cowConstructors).toBeLessThanOrEqual(512 * (units + 1))
    expect(cost.wrapperConstructors).toBeLessThanOrEqual(512 * (units + 1) * height)
    expect(cost.clears).toBeLessThanOrEqual(4097 * (units + 1))
    expect(cost.populationCopiedInputs).toBe(0)
    // Only the existing fixed settlement-ID preparation may copy a retained population.
    expect(cost.settlementConstructorInputs).toBeLessThanOrEqual(
      4096 * (phase.rows + phase.outputs + 1)
    )
    expect(cost.settlementIteratorSteps).toBeLessThanOrEqual(
      4 * 4096 * (phase.rows + phase.outputs + 1)
    )
    expect(cost.constructorInputs - cost.settlementConstructorInputs).toBeLessThanOrEqual(
      64 * (units + 1)
    )
    expect(cost.iteratorSteps - cost.settlementIteratorSteps).toBeLessThanOrEqual(128 * (units + 1))
    if (noPopulationWalk.has(name)) {
      for (const [space, values] of Object.entries(cost.namespaces)) {
        if (forbidden.test(space.replace(/^selection:/, ''))) {
          expect(values.iterated, `${name} traversed retained ${space}`).toBe(0)
        }
      }
    }
    expect(cost.sqlExecStatements).toBeLessThanOrEqual(64 * (units + 1))
    expect(cost.changedRows + cost.secondaryWrites + cost.rangeRows).toBeLessThanOrEqual(
      128 + 8192 * units * height
    )
    expect(cost.encodedBytes + cost.sourceEncodedBytes).toBeLessThanOrEqual(
      4096 * (units + 1) * height * (maximumRowBytes + 256)
    )
    expect(cost.checkpointBytes).toBeLessThanOrEqual(
      64 * (units + 1) * (4096 + 8 * maximumRowBytes)
    )
    expect(cost.rawRowParseBytes).toBeLessThanOrEqual(cost.rawRowParses * maximumRowBytes)
    expect(cost.rawRowParses).toBeLessThanOrEqual(32 * (cost.structuralRowSteps + phase.rows + 1))
    expect(cost.populationDeletes, `${name} N=${n}: population DELETE`).toBe(0)
    for (const [space, cardinality] of Object.entries(cost.countNamespaces)) {
      if (space.startsWith('selection:') || /^(requests|clears|work:)/.test(space)) {
        expect(cardinality).toBe(0)
      }
    }
    expect(cost.countNamespaces.settlements ?? 0).toBeLessThanOrEqual(
      4096 * (phase.rows + phase.outputs + 1)
    )
    expect(cost.countCardinality - (cost.countNamespaces.settlements ?? 0)).toBeLessThanOrEqual(
      name === 'structural-resume-cleanup' ? 64 * tip : n + 1
    )
    expect(cost.countCardinality).toBeLessThanOrEqual(4097 * (units + phase.diagnostic + 1))
  }
  for (const name of [
    'legacy-irrelevant',
    'shared-legacy-point',
    'shared-legacy-series',
    'shared-legacy-noncommand-report'
  ]) {
    const cost = phases[name]
    expect(cost.legacyClassifications, name).toBe(0)
    expect(cost.legacyDisplayEvaluations, name).toBe(0)
    expect(cost.legacyDependentYields, name).toBe(0)
    expect(cost.legacyDirtyMembers, name).toBe(0)
  }
  expect(phases['shared-legacy-open'].failedSql).toBeGreaterThan(0)
  expect(phases['legacy-failed-import'].failedSql).toBeGreaterThan(0)
  const relevantPoint = phases['shared-legacy-relevant-point']
  const relevantSeries = phases['shared-legacy-relevant']
  expect(relevantPoint.legacyClassifications).toBe(1)
  expect(relevantPoint.legacyDisplayEvaluations).toBe(1)
  expect(relevantPoint.legacyDirtyMembers).toBe(1)
  expect(relevantSeries.legacyClassifications).toBe(n - 1)
  expect(relevantSeries.legacyDisplayEvaluations).toBe(n - 1)
  expect(relevantSeries.legacyDirtyMembers).toBe(n - 1)
  expect(relevantPoint.legacyDirtyMembers + relevantSeries.legacyDirtyMembers).toBe(n)
  const structural = phases['structural-resume-cleanup']
  const replay = inputs['structural-resume-cleanup']
  const rowAndDependencyUnits = replay.rows + replay.outputs + replay.lineage
  expect(structural.structuralRowSteps).toBeGreaterThanOrEqual(tip)
  expect(structural.dependencySteps).toBeGreaterThan(0)
  expect(structural.rawRowParses).toBeGreaterThanOrEqual(tip)
  expect(structural.terminalCursorProbes).toBeGreaterThan(0)
  expect(structural.structuralRowSteps + structural.dependencySteps).toBeLessThanOrEqual(
    256 * rowAndDependencyUnits
  )
  expect(structural.cleanupSteps).toBe(upgrade.cleanupSteps)
  expect(upgrade.cleanupSteps).toBeLessThanOrEqual(256 * (tip + n))
  expect(upgrade.checkpoints).toBeLessThanOrEqual(64 * (tip + n + 4097))
  expect(upgrade.cleanupRows).toBeLessThanOrEqual(256 * (tip + n))
  expect(structural.wrapperKinds.StructuralMap).toBeGreaterThan(0)
  expect(phases.construction.wrapperKinds.SourceMap).toBeGreaterThan(0)
}
