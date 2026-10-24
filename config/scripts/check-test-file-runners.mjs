#!/usr/bin/env node
// Static gate: a checked-in test file that no runner collects passes vacuously, so every one must be collected.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { buildUnitDependencyGraph, unitConsumers } from './ci-unit-dependency-graph.mjs'
import { UNIT_INCLUDE } from './ci-unit-files.mjs'

const VITEST_DEFAULT_INCLUDE = '**/*.{test,spec}.?(c|m)[jt]s?(x)'

// `mirrors` are literals the runner's own config must still contain, so a config edit cannot drift silently.
export const TEST_RUNNERS = [
  { name: 'unit (config/vitest.config.ts)', include: UNIT_INCLUDE },
  {
    name: 'Playwright e2e',
    include: ['tests/e2e/**/*.spec.ts'],
    source: 'tests/playwright.config.ts',
    mirrors: ["testDir: './e2e'", "testMatch: '**/*.spec.ts'"]
  },
  {
    name: 'computer-use e2e',
    include: ['tests/e2e/computer-*.e2e.ts'],
    source: 'tests/e2e/vitest.config.ts',
    mirrors: ["'tests/e2e/computer-*.e2e.ts'"]
  },
  {
    name: 'performance benchmarks',
    include: [
      'src/renderer/src/components/editor/monaco-content-sync.bench.ts',
      'src/renderer/src/components/editor/monaco-content-sync.undo-retention.bench.ts'
    ],
    source: 'config/vitest.performance.config.ts',
    mirrors: [
      "'src/renderer/src/components/editor/monaco-content-sync.bench.ts'",
      "'src/renderer/src/components/editor/monaco-content-sync.undo-retention.bench.ts'",
      'benchmark: { include: benchmarks }'
    ]
  },
  {
    name: 'agent-status benchmark',
    include: ['config/scripts/agent-status-hot-path-benchmark.ts'],
    source: 'config/vitest.agent-status-benchmark.config.ts',
    mirrors: ["'config/scripts/agent-status-hot-path-benchmark.ts'"]
  },
  {
    name: 'mobile',
    include: ['mobile/src/**/*.test.ts', 'mobile/src/**/*.test.tsx', 'mobile/scripts/**/*.test.ts'],
    source: 'mobile/vitest.config.ts',
    mirrors: [
      'root: import.meta.dirname',
      "'src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts'"
    ]
  },
  ...['push', 'relay'].map((app) => ({
    name: `cloud ${app}`,
    include: [`cloud/apps/${app}/src/**/*.test.ts`],
    source: `cloud/apps/${app}/vitest.config.ts`,
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
    source: `${dir}/package.json`,
    mirrors: ['vitest run']
  })),
  {
    name: 'cloud node:test',
    include: [
      'cloud/dev/scripts/run-relay-tests.test.mjs',
      '.github/actions/cloud-sql-rollout-lease/*.test.mjs'
    ],
    source: 'cloud/package.json',
    mirrors: [
      'dev/scripts/run-relay-tests.test.mjs',
      '../.github/actions/cloud-sql-rollout-lease/*.test.mjs'
    ]
  },
  {
    name: 'docs site',
    include: ['docs/site/tests/*.test.mjs'],
    source: 'docs/site/package.json',
    mirrors: ['node --test tests/*.test.mjs']
  }
]

const CODE_FILE = /\.[cm]?[jt]sx?$/
const TEST_NAME = /\.(?:test|spec|e2e|bench)\.[cm]?[jt]sx?$/
const TEST_FRAMEWORK_IMPORT = /\bfrom\s+['"](?:vitest|node:test|@playwright\/test|bun:test)['"]/
const TYPE_ONLY_IMPORT = /^\s*(?:import|export)\s+type\s[^'"]*?\sfrom\s*['"][^'"]+['"]/gm
const TEST_REGISTRATION =
  /^\s*(?:describe|it|test|suite|bench)(?:\.\w+)*(?:\([^)]*\))?\s*\(\s*[`'"]/m

export function isTestLike(file, source) {
  return (
    TEST_NAME.test(file) || (TEST_FRAMEWORK_IMPORT.test(source) && TEST_REGISTRATION.test(source))
  )
}

export function findRunnerDrift(runners, readSource) {
  const problems = []
  for (const { name, source, mirrors = [] } of runners) {
    if (!source) {
      continue
    }
    const text = readSource(source)
    for (const literal of mirrors) {
      if (text === null || !text.includes(literal)) {
        problems.push(`${name}: ${source} no longer contains ${JSON.stringify(literal)}`)
      }
    }
  }
  return problems
}

// A suite module (e.g. `Foo.case.spec.tsx`) is collected when a selected entry file imports it.
export function findUncollectedTestFiles(sources, runners) {
  const files = [...sources.keys()]
  const selected = new Set(
    files.filter((file) =>
      runners.some(({ include }) => include.some((glob) => path.matchesGlob(file, glob)))
    )
  )
  const candidates = files.filter(
    (file) => !selected.has(file) && isTestLike(file, sources.get(file))
  )
  if (candidates.length === 0) {
    return []
  }
  // Why strip: type-only imports are erased, so they never run the imported module's suites.
  const runtimeSources = new Map(
    [...sources].map(([file, source]) => [file, source.replace(TYPE_ONLY_IMPORT, '')])
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
  const uncollected = findUncollectedTestFiles(trackedCodeSources(root), TEST_RUNNERS)
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
  console.log('Every checked-in test file is collected by a test runner.')
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd()))
}
