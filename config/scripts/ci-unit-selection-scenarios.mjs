import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProcessSync } from '@orca/process-host'
import { collectUnitDependencyGraph } from './ci-unit-dependency-graph.mjs'
import { discoverUnitFiles } from './ci-unit-files.mjs'
import { selectUnitFiles } from './ci-unit-selection.mjs'
import { readUnitSelectionRecords, reviewUnitSelection } from './ci-unit-selection-review.mjs'

const sameFiles = (left, right) =>
  Array.isArray(left) && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())

export function auditUnitScenarios(records, { sourceSha, files, graph, scenarios }) {
  if (
    !sourceSha ||
    !records.length ||
    records.some(
      ({ plan, timing }) =>
        plan.sourceSha !== sourceSha ||
        timing.sourceSha !== sourceSha ||
        !sameFiles(plan.files, files) ||
        !sameFiles(plan.executionFiles, files)
    )
  ) {
    throw new Error('Evidence must match the checkout revision and complete test inventory')
  }
  if (reviewUnitSelection(records).some((row) => !row.completeFullRun)) {
    throw new Error('Every reference must be a complete full run')
  }
  if (
    !scenarios ||
    Array.isArray(scenarios) ||
    typeof scenarios !== 'object' ||
    !Object.keys(scenarios).length ||
    Object.entries(scenarios).some(
      ([name, paths]) =>
        !name.trim() ||
        !Array.isArray(paths) ||
        paths.some(
          (path) =>
            typeof path !== 'string' ||
            !path.length ||
            path.startsWith('/') ||
            /^[a-z]:/i.test(path) ||
            path.includes('\\') ||
            path.split('/').some((part) => part === '.' || part === '..')
        )
    )
  ) {
    throw new Error('Scenarios must map names to arrays of repository-relative changed paths')
  }
  let dependencyGraph
  const loadGraph = () => (dependencyGraph ??= typeof graph === 'function' ? graph() : graph)
  return Object.entries(scenarios).map(([scenario, changed]) => {
    const candidate = selectUnitFiles(files, changed, loadGraph)
    const replay = records.map(({ plan, timing }) => ({
      plan: {
        ...plan,
        candidateFiles: candidate.files,
        selectionAvailable: !candidate.full,
        reason: candidate.reason
      },
      timing
    }))
    return {
      scenario,
      changed,
      candidateFiles: candidate.files,
      references: reviewUnitSelection(replay)
    }
  })
}

function gitOutput(args) {
  const result = runProcessSync({ program: 'git', args, maxOutputBytes: 16 * 1024 * 1024 })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error('Checkout revision or status unavailable')
  }
  return result.stdout.trim()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [directory, scenariosPath, ...extra] = process.argv.slice(2)
  if (!directory || !scenariosPath || extra.length) {
    throw new Error('Usage: ci-unit-selection-scenarios.mjs ARTIFACT_DIRECTORY SCENARIOS_JSON')
  }
  if (gitOutput(['rev-parse', '--show-prefix'])) {
    throw new Error('Run from the repository root')
  }
  if (gitOutput(['status', '--porcelain', '--untracked-files=normal'])) {
    throw new Error('Commit or stash checkout changes before auditing pinned evidence')
  }
  const tracked = new Set(gitOutput(['ls-files', '-z']).split('\0'))
  const requireTracked = (files) => {
    for (const file of files) {
      if (!tracked.has(file)) {
        throw new Error(`Untracked or ignored audit input: ${file}`)
      }
    }
  }
  const files = discoverUnitFiles()
  requireTracked(files)
  const report = auditUnitScenarios(readUnitSelectionRecords(directory), {
    sourceSha: gitOutput(['rev-parse', 'HEAD']),
    files,
    graph: () => {
      const graph = collectUnitDependencyGraph()
      requireTracked(graph.files)
      return graph
    },
    scenarios: JSON.parse(readFileSync(scenariosPath, 'utf8'))
  })
  writeFileSync(join(directory, 'selection-scenarios.json'), `${JSON.stringify(report, null, 2)}\n`)
  for (const { scenario, references } of report) {
    for (const row of references) {
      console.log(
        `${scenario} / Node ${row.nodeVersion}${row.bunVersion ? ` / Bun ${row.bunVersion}` : ''}: ${row.candidateFiles}/${row.files} candidate files; ${row.selectionEvaluated ? 'selection evaluated' : 'full fallback'}; ${row.missedFailures.length} failures outside selection; ${(row.potentiallyOmittedWorkerMs / 60_000).toFixed(1)} potentially omitted worker-minutes`
      )
    }
  }
  console.log(
    'Replay checks recorded failures only; it does not simulate edits or measure CI speed.'
  )
}
