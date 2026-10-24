#!/usr/bin/env node
// Static gate: a checked-in test file that no runner collects passes vacuously, so every one must be collected.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript-api'
import { defaultExclude } from 'vitest/config'
import { buildUnitDependencyGraph, unitConsumers } from './ci-unit-dependency-graph.mjs'
import { UNIT_EXCLUDE, UNIT_INCLUDE } from './ci-unit-files.mjs'

const VITEST_DEFAULT_INCLUDE = '**/*.{test,spec}.?(c|m)[jt]s?(x)'

const TEST_FILE_NAME = /\.(?:test|spec|e2e|bench)\.[cm]?[jt]sx?$/

// `mirrors` are literals the runner's own `sources` must contain; editing one of them fails the check.
// `manual` rows have a runner but no CI job; they are listed on every run so they stay visible.
const NON_UNIT_TEST_RUNNERS = [
  {
    name: 'Playwright e2e',
    include: ['tests/e2e/**/*.spec.ts'],
    sources: ['tests/playwright.config.ts'],
    mirrors: ["testDir: './e2e'", "testMatch: '**/*.spec.ts'"]
  },
  {
    name: 'computer-use e2e',
    include: ['tests/e2e/computer-*.e2e.ts'],
    sources: ['tests/e2e/vitest.config.ts'],
    mirrors: ["'tests/e2e/computer-*.e2e.ts'"]
  },
  {
    name: 'performance benchmarks (pnpm test:perf:benchmarks)',
    manual: true,
    include: [
      'src/renderer/src/components/editor/monaco-content-sync.bench.ts',
      'src/renderer/src/components/editor/monaco-content-sync.undo-retention.bench.ts'
    ],
    sources: ['config/vitest.performance.config.ts'],
    mirrors: [
      "'src/renderer/src/components/editor/monaco-content-sync.bench.ts'",
      "'src/renderer/src/components/editor/monaco-content-sync.undo-retention.bench.ts'",
      'benchmark: { include: benchmarks }'
    ]
  },
  {
    name: 'agent-status benchmark',
    manual: true,
    include: ['config/scripts/agent-status-hot-path-benchmark.ts'],
    sources: ['config/vitest.agent-status-benchmark.config.ts'],
    mirrors: ["'config/scripts/agent-status-hot-path-benchmark.ts'"]
  },
  {
    name: 'mobile',
    include: ['mobile/src/**/*.test.ts', 'mobile/src/**/*.test.tsx', 'mobile/scripts/**/*.test.ts'],
    sources: ['mobile/vitest.config.ts'],
    mirrors: [
      'root: import.meta.dirname',
      "'src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts'"
    ]
  },
  ...['push', 'relay'].map((app) => ({
    name: `cloud ${app}`,
    include: [`cloud/apps/${app}/src/**/*.test.ts`],
    sources: [`cloud/apps/${app}/vitest.config.ts`],
    mirrors: ["include: ['src/**/*.test.ts']"]
  })),
  ...[
    'cloud/apps/relay-fence-broker',
    'cloud/packages/postgres-schema',
    'cloud/packages/push-contract',
    'cloud/packages/relay-contract'
  ].map((dir) => ({
    name: dir,
    include: [`${dir}/${VITEST_DEFAULT_INCLUDE}`],
    sources: [`${dir}/package.json`],
    mirrors: ['vitest run']
  })),
  {
    name: 'cloud node:test',
    include: [
      'cloud/dev/scripts/run-relay-tests.test.mjs',
      '.github/actions/cloud-sql-rollout-lease/*.test.mjs'
    ],
    sources: ['cloud/package.json'],
    mirrors: [
      'dev/scripts/run-relay-tests.test.mjs',
      '../.github/actions/cloud-sql-rollout-lease/*.test.mjs'
    ]
  },
  {
    name: 'docs site',
    include: ['docs/site/tests/*.test.mjs'],
    sources: ['docs/site/package.json'],
    mirrors: ['node --test tests/*.test.mjs']
  }
]

const DEDICATED_UNIT_FILES = UNIT_EXCLUDE.filter((glob) => !defaultExclude.includes(glob))

export const TEST_RUNNERS = [
  { name: 'unit (config/vitest.config.ts)', include: UNIT_INCLUDE, exclude: UNIT_EXCLUDE },
  {
    // Why mirrors: an UNIT_EXCLUDE entry no workflow names would otherwise leave CI silently.
    name: 'dedicated unit jobs (UNIT_EXCLUDE)',
    include: DEDICATED_UNIT_FILES,
    sources: ['.github/workflows/pr.yml', '.github/workflows/unit-tests.yml'],
    mirrors: DEDICATED_UNIT_FILES.map((glob) => glob.replace(/\*\*$/, ''))
  },
  ...NON_UNIT_TEST_RUNNERS
]

const CODE_FILE = /\.[cm]?[jt]sx?$/
const TEST_FRAMEWORK_IMPORT = /\bfrom\s+['"](?:vitest|node:test|@playwright\/test|bun:test)['"]/
const TEST_REGISTRATION =
  /^\s*(?:describe|it|test|suite|bench)(?:\.\w+)*(?:\([^)]*\))?\s*\(\s*[`'"]/m
// Cheap prefilter; the parser decides what is actually type-only.
const MAY_HAVE_TYPE_ONLY_IMPORT = /\b(?:import|export)\s*(?:type\b|\{[^}]*\btype\s)/

export function isTestLike(file, source) {
  return (
    TEST_FILE_NAME.test(file) ||
    (TEST_FRAMEWORK_IMPORT.test(source) && TEST_REGISTRATION.test(source))
  )
}

export function findRunnerDrift(runners, readSource) {
  const problems = []
  for (const { name, sources = [], mirrors = [] } of runners) {
    const texts = sources.map((source) => [source, readSource(source)])
    for (const [source, text] of texts) {
      if (text === null) {
        problems.push(`${name}: ${source} is missing`)
      }
    }
    const combined = texts.map(([, text]) => text ?? '').join('\n')
    for (const literal of mirrors) {
      if (!combined.includes(literal)) {
        problems.push(`${name}: ${sources.join(', ')} no longer contain ${JSON.stringify(literal)}`)
      }
    }
  }
  return problems
}

function allTypeOnly(elements) {
  return elements.length > 0 && elements.every((element) => element.isTypeOnly)
}

function isTypeOnlyModuleStatement(statement) {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause
    if (!clause) {
      return false
    }
    const bindings = clause.namedBindings
    return (
      clause.isTypeOnly ||
      (!clause.name &&
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        allTypeOnly(bindings.elements))
    )
  }
  if (ts.isExportDeclaration(statement)) {
    const clause = statement.exportClause
    return (
      statement.isTypeOnly ||
      (clause !== undefined && ts.isNamedExports(clause) && allTypeOnly(clause.elements))
    )
  }
  return false
}

// Why: type-only imports are erased, so they never run the imported module's suites.
export function withoutTypeOnlyImports(file, source) {
  if (!MAY_HAVE_TYPE_ONLY_IMPORT.test(source)) {
    return source
  }
  const kind = /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, kind)
  let result = source
  for (const statement of sourceFile.statements.toReversed()) {
    if (isTypeOnlyModuleStatement(statement)) {
      result = result.slice(0, statement.getStart(sourceFile)) + result.slice(statement.end)
    }
  }
  return result
}

function collects({ include, exclude = [] }, file) {
  const matches = (glob) => path.matchesGlob(file, glob)
  return include.some(matches) && !exclude.some(matches)
}

// A suite module (e.g. `Foo.case.spec.tsx`) is collected when a selected entry file imports it.
export function findUncollectedTestFiles(sources, runners) {
  const files = [...sources.keys()]
  const selected = new Set(files.filter((file) => runners.some((runner) => collects(runner, file))))
  const candidates = files.filter(
    (file) => !selected.has(file) && isTestLike(file, sources.get(file))
  )
  if (candidates.length === 0) {
    return []
  }
  const runtimeSources = new Map(
    [...sources].map(([file, source]) => [file, withoutTypeOnlyImports(file, source)])
  )
  const { reverse } = buildUnitDependencyGraph(runtimeSources)
  return candidates.filter(
    (file) => ![...unitConsumers([file], reverse)].some((consumer) => selected.has(consumer))
  )
}

function trackedCodeSources(root) {
  // Why git: worktrees and build output nest under the checkout, and only committed files matter.
  const stdout = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  })
  return new Map(
    stdout
      .split('\0')
      .filter((file) => CODE_FILE.test(file) && !file.split('/').includes('node_modules'))
      .map((file) => [file, readFileSync(path.join(root, file), 'utf8')])
  )
}

function main(root) {
  const drift = findRunnerDrift(TEST_RUNNERS, (file) => {
    try {
      return readFileSync(path.join(root, file), 'utf8')
    } catch {
      return null
    }
  })
  const sources = trackedCodeSources(root)
  const uncollected = findUncollectedTestFiles(sources, TEST_RUNNERS)
  for (const problem of drift) {
    console.error(`Runner list is out of date: ${problem}`)
  }
  for (const file of uncollected) {
    console.error(`No test runner collects ${file}`)
  }
  if (drift.length > 0 || uncollected.length > 0) {
    console.error(
      'Rename the file to a collected pattern, import it from a collected entry, or add its runner to TEST_RUNNERS in config/scripts/check-test-file-runners.mjs.'
    )
    return 1
  }
  for (const runner of TEST_RUNNERS.filter(({ manual }) => manual)) {
    const files = [...sources.keys()].filter((file) => collects(runner, file))
    console.log(`Manual only, no CI job: ${runner.name}: ${files.join(', ')}`)
  }
  console.log('Every checked-in test file is collected by a test runner.')
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd()))
}
