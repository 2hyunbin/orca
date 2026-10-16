import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runProcessSync } from '@orca/process-host'
import { classifyNodeServerChanges, collectNodeServerInputs } from './node-server-change-scope.mjs'
import { discoverUnitFiles } from './ci-unit-files.mjs'
import { NODE_SERVER_RUNNERS } from './node-server-qualification.mjs'

const temporaryDirs = []
afterEach(() => {
  for (const root of temporaryDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function moduleTree(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-registration-scope-'))
  temporaryDirs.push(root)
  for (const [file, source] of Object.entries(files)) {
    const path = join(root, file)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, source)
  }
  return root
}

const registrationRoot = 'src/main/runtime/orca-runtime.test.ts'
const registrationFragment =
  'src/main/runtime/orca-runtime-tests/repository-project-operations.spec.ts'
const registrationDiff = (files = [registrationFragment]) =>
  files.map((file) => `:100644 100644 ${'1'.repeat(40)} ${'2'.repeat(40)} M\0${file}\0`).join('')
const registrationEvidence = (files = [registrationFragment]) => ({
  modifiedFiles: files,
  rawDiff: registrationDiff(files)
})

it.each([false, true])(
  'checks both registration and server graphs before skipping: consumed=%s',
  async (consumed) => {
    const root = moduleTree({
      [registrationRoot]:
        "import './orca-runtime-tests/repository-project-operations.spec'; throw Error('never execute root')",
      [registrationFragment]: "export const value = 1; throw Error('never execute fragment')",
      'entry.ts': consumed ? `import './${registrationFragment}'` : 'export const value = 1'
    })
    const result = await classifyNodeServerChanges(
      [registrationFragment],
      () => collectNodeServerInputs({ root, entryPoints: ['entry.ts'] }),
      {
        ...registrationEvidence(),
        collectRegistrationInputs: (options) => collectNodeServerInputs({ root, ...options })
      }
    )
    expect(result.shouldRun).toBe(consumed)
    expect(result.graphResolved).toBe(true)
    expect(result.matchedFiles).toEqual(consumed ? [registrationFragment] : [])
  }
)

it('proves every changed registration in the bounded runtime test directory', async () => {
  const other = 'src/main/runtime/orca-runtime-tests/terminal-listing.spec.ts'
  const changed = [registrationFragment, other]
  const root = moduleTree({
    [registrationRoot]:
      "import './orca-runtime-tests/repository-project-operations.spec'; import './orca-runtime-tests/terminal-listing.spec'; throw Error('never execute root')",
    [registrationFragment]: "import 'vitest'; throw Error('never execute fragment')",
    [other]: 'export {}',
    'entry.ts': 'export {}'
  })
  const collectRegistrationInputs = (options) => collectNodeServerInputs({ root, ...options })
  const result = await classifyNodeServerChanges(
    changed,
    () => collectNodeServerInputs({ root, entryPoints: ['entry.ts'] }),
    { ...registrationEvidence(changed), collectRegistrationInputs }
  )
  expect(result.shouldRun).toBe(false)
  writeFileSync(
    join(root, registrationRoot),
    "import './orca-runtime-tests/repository-project-operations.spec'"
  )
  const unregistered = await classifyNodeServerChanges(
    changed,
    () => collectNodeServerInputs({ root, entryPoints: ['entry.ts'] }),
    { ...registrationEvidence(changed), collectRegistrationInputs }
  )
  expect(unregistered.shouldRun).toBe(true)
  expect(unregistered.graphUnavailable).toBe(true)
})

it.each(['unregistered', 'unknown-fragment', 'missing-root', 'broken-import'])(
  'retains qualification when the registration root is %s',
  async (condition) => {
    const fragment =
      condition === 'unknown-fragment'
        ? 'src/main/runtime/orca-runtime-tests/unknown.spec.ts'
        : registrationFragment
    const root = moduleTree({
      ...(condition === 'missing-root'
        ? {}
        : {
            [registrationRoot]: condition === 'broken-import' ? "import './missing'" : 'export {}'
          }),
      [fragment]: 'export {}'
    })
    const result = await classifyNodeServerChanges([fragment], async () => new Set(['entry.ts']), {
      ...registrationEvidence([fragment]),
      collectRegistrationInputs: (options) => collectNodeServerInputs({ root, ...options })
    })
    expect(result.shouldRun).toBe(true)
    expect(result.graphUnavailable).toBe(true)
  }
)

it.each([
  null,
  [],
  {},
  new Map(),
  new Set(),
  new Set([registrationRoot]),
  new Set([registrationFragment])
])('retains qualification for incomplete registration evidence: %j', async (registrationInputs) => {
  const result = await classifyNodeServerChanges(
    [registrationFragment],
    async () => new Set(['entry.ts']),
    { ...registrationEvidence(), collectRegistrationInputs: async () => registrationInputs }
  )
  expect(result.shouldRun).toBe(true)
  expect(result.graphUnavailable).toBe(true)
})

it.each([null, [], {}, new Map(), new Set()])(
  'retains qualification when the actual server graph is incomplete: %j',
  async (serverInputs) => {
    const result = await classifyNodeServerChanges(
      [registrationFragment],
      async () => serverInputs,
      {
        ...registrationEvidence(),
        collectRegistrationInputs: async () => new Set([registrationRoot, registrationFragment])
      }
    )
    expect(result.shouldRun).toBe(true)
    expect(result.graphUnavailable).toBe(true)
  }
)

it.each([
  {},
  { modifiedFiles: [registrationFragment] },
  { rawDiff: registrationDiff() },
  { ...registrationEvidence(), modifiedFiles: [] },
  { ...registrationEvidence(), modifiedFiles: [registrationFragment, registrationFragment] },
  { ...registrationEvidence(), modifiedFiles: ['src/main/runtime/foreign.test.ts'] },
  { ...registrationEvidence(), rawDiff: registrationDiff().slice(0, -1) },
  { ...registrationEvidence(), rawDiff: registrationDiff().replaceAll('\0', '\n') },
  {
    ...registrationEvidence(),
    rawDiff: registrationDiff().replace('1'.repeat(40), '0'.repeat(40))
  },
  {
    ...registrationEvidence(),
    rawDiff: registrationDiff().replace('2'.repeat(40), '0'.repeat(40))
  },
  {
    ...registrationEvidence(),
    rawDiff: registrationDiff().replace('2'.repeat(40), '2'.repeat(64))
  },
  {
    ...registrationEvidence(),
    rawDiff: registrationDiff().replace('1'.repeat(40), 'g'.repeat(40))
  },
  {
    ...registrationEvidence(),
    rawDiff: registrationDiff().replace('100644 100644', '100644 100755')
  },
  {
    ...registrationEvidence(),
    rawDiff: registrationDiff().replace('100644 100644', '120000 120000')
  },
  { ...registrationEvidence(), rawDiff: registrationDiff().replace(' M\0', ' A\0') },
  { ...registrationEvidence(), rawDiff: registrationDiff().replace(' M\0', ' D\0') },
  { ...registrationEvidence(), rawDiff: registrationDiff().replace(' M\0', ' R100\0') },
  { ...registrationEvidence(), rawDiff: registrationDiff().replace(' M\0', ' T\0') },
  { ...registrationEvidence(), rawDiff: registrationDiff(['src/main/runtime/foreign.spec.ts']) },
  { ...registrationEvidence(), rawDiff: registrationDiff() + registrationDiff() }
])(
  'does not exempt a registration path with incomplete ordinary-modification evidence: %j',
  async (evidence) => {
    const result = await classifyNodeServerChanges(
      [registrationFragment],
      async () => {
        throw new Error('invalid evidence must not reach graph collection')
      },
      evidence
    )
    expect(result.shouldRun).toBe(true)
    expect(result.graphUnavailable).toBeUndefined()
    expect(result.reason).toBe(`Build or CI input changed: ${registrationFragment}`)
  }
)

it('defers both registration and server graphs until dependencies are available', async () => {
  const unavailable = async () => {
    throw new Error('no graph collection during deferred detection')
  }
  const result = await classifyNodeServerChanges([registrationFragment], unavailable, {
    ...registrationEvidence(),
    deferGraph: true,
    collectRegistrationInputs: unavailable
  })
  expect(result.graphRequired).toBe(true)
  expect(result.shouldRun).toBeUndefined()
})

it.each([
  'src/main/runtime/orca-runtime-tests/nested/unknown.spec.ts',
  'src/main/runtime/unknown.spec.ts',
  'src/main/runtime/orca-runtime-tests/worker.ts',
  'src/main/runtime/orca-runtime-tests/fixture.spec.ts.fixture',
  'src/main/runtime/orca-runtime.ts',
  'src/main/persistence/example/worker.ts',
  'native/windows-security/src/addon.cc',
  'config/scripts/build-orcad-node.mjs',
  'config/scripts/node-server-change-scope.mjs',
  'src/main/sqlite/example.test.ts'
])('does not let a recognized registration exempt a protected companion: %s', async (file) => {
  const changed = [registrationFragment, file]
  const result = await classifyNodeServerChanges(
    changed,
    async () => {
      throw new Error('protected inputs must not reach graphs')
    },
    registrationEvidence(changed)
  )
  expect(result.shouldRun).toBe(true)
  expect(result.graphUnavailable).toBeUndefined()
  expect(result.reason).toBe(`Build or CI input changed: ${file}`)
})

it.each([
  '',
  '/outside.ts',
  '../outside.ts',
  './entry.ts',
  'src/../entry.ts',
  'src/./entry.ts',
  'src//entry.ts',
  'C:/outside.ts',
  'src\\entry.ts',
  'entry\0.ts',
  'entry\r.ts',
  'entry\n.ts',
  null,
  17
])('retains qualification for malformed graph input %j', async (invalid) => {
  for (const invalidGraph of ['server', 'registration']) {
    const server = new Set(['entry.ts'])
    const registration = new Set([registrationRoot, registrationFragment])
    const graph = invalidGraph === 'server' ? server : registration
    graph.add(invalid)
    const result = await classifyNodeServerChanges([registrationFragment], async () => server, {
      ...registrationEvidence(),
      collectRegistrationInputs: async () => registration
    })
    expect(result.shouldRun).toBe(true)
    expect(result.graphUnavailable).toBe(true)
  }
})

it('retains qualification when the registration graph reports a warning', async () => {
  const root = moduleTree({
    [registrationRoot]:
      "import './orca-runtime-tests/repository-project-operations.spec'; const part = 'absent'; import(`./orca-runtime-tests/missing-${part}.ts`)",
    [registrationFragment]: 'export {}'
  })
  const result = await classifyNodeServerChanges(
    [registrationFragment],
    async () => new Set(['entry.ts']),
    {
      ...registrationEvidence(),
      collectRegistrationInputs: (options) => collectNodeServerInputs({ root, ...options })
    }
  )
  expect(result.shouldRun).toBe(true)
  expect(result.graphUnavailable).toBe(true)
  expect(result.reason).toContain('glob pattern')
})

it.each([true, false])(
  'uses strict evidence in an uninstalled CLI checkout: deferred=%s',
  (deferred) => {
    const root = moduleTree(
      Object.fromEntries(
        [
          'node-server-change-scope',
          'node-server-test-paths',
          'node-server-qualification',
          'node-server-native-compat-scope'
        ].map((name) => [
          `config/scripts/${name}.mjs`,
          readFileSync(new URL(`./${name}.mjs`, import.meta.url), 'utf8')
        ])
      )
    )
    const changes = join(root, 'changes')
    const statuses = join(root, 'raw-diff')
    const stepOutput = join(root, 'step-output')
    writeFileSync(changes, `${registrationFragment}\0`)
    writeFileSync(statuses, registrationDiff())
    const result = runProcessSync({
      program: process.execPath,
      args: [
        realpathSync(join(root, 'config/scripts/node-server-change-scope.mjs')),
        changes,
        '--pull-request',
        '--modified-paths',
        changes,
        '--diff-paths',
        statuses,
        ...(deferred ? ['--defer-graph'] : [])
      ],
      cwd: root,
      env: { ...process.env, GITHUB_OUTPUT: stepOutput },
      timeoutMs: 5_000
    })
    expect(result.code).toBe(0)
    const output = readFileSync(stepOutput, 'utf8')
    if (deferred) {
      expect(output).toBe('graph_required=true\n')
    } else {
      expect(output).toContain('should_run=true\nqualification=true\n')
      expect(output).toContain(`runners=${JSON.stringify(NODE_SERVER_RUNNERS)}\n`)
      expect(output).toContain('native_compatibility=true\n')
    }
  }
)

describe('actual runtime registration and historical changed-file evidence', () => {
  const root = resolve(import.meta.dirname, '../..')
  const historical = JSON.parse(
    readFileSync(
      new URL('./node-server-runtime-registration.test-fixture.json', import.meta.url),
      'utf8'
    )
  )
  let serverInputs
  let registrationInputs
  beforeAll(async () => {
    serverInputs = await collectNodeServerInputs()
    registrationInputs = await collectNodeServerInputs({ entryPoints: [registrationRoot] })
  }, 60_000)

  it('selects the known root in ordinary unit discovery and registers the changed fragment', () => {
    expect(discoverUnitFiles(root)).toContain(registrationRoot)
    expect(registrationInputs.has(registrationRoot)).toBe(true)
    expect(registrationInputs.has(registrationFragment)).toBe(true)
    expect(historical.changedFiles.every((file) => !serverInputs.has(file))).toBe(true)
  })

  it('skips the historical five-file diff only after proving the actual current graphs', async () => {
    const result = await classifyNodeServerChanges(
      historical.changedFiles,
      async () => serverInputs,
      {
        modifiedFiles: historical.changedFiles,
        rawDiff: historical.rawDiff,
        collectRegistrationInputs: async () => registrationInputs
      }
    )
    expect(result).toMatchObject({ shouldRun: false, graphResolved: true, matchedFiles: [] })
  })

  it('classifies the exact historical raw bytes through the installed CLI with private outputs', () => {
    const receiptRoot = moduleTree()
    const changes = join(receiptRoot, 'changes')
    const statuses = join(receiptRoot, 'raw-diff')
    const stepOutput = join(receiptRoot, 'step-output')
    writeFileSync(changes, historical.changedFiles.map((file) => `${file}\0`).join(''))
    writeFileSync(statuses, historical.rawDiff)
    const result = runProcessSync({
      program: process.execPath,
      args: [
        realpathSync(join(root, 'config/scripts/node-server-change-scope.mjs')),
        changes,
        '--pull-request',
        '--modified-paths',
        changes,
        '--diff-paths',
        statuses
      ],
      cwd: root,
      env: { ...process.env, GITHUB_OUTPUT: stepOutput },
      timeoutMs: 60_000
    })
    expect(result.code).toBe(0)
    expect(readFileSync(stepOutput, 'utf8')).toBe(
      'should_run=false\nqualification=false\nrunners=["ubuntu-22.04"]\nnative_compatibility=false\n'
    )
  }, 60_000)
})
