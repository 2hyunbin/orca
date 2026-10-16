import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runProcessSync } from '@orca/process-host'

const root = process.cwd()
const directory = path.join(root, 'close-capture')
const require = createRequire(import.meta.url)
const mode = process.argv[2]
const hash = (value) => createHash('sha256').update(value).digest('hex')
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const save = (name, value) =>
  writeFileSync(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`)
const prefixes = [
  'orca-e2e-restart-',
  'orca-e2e-userdata-',
  'orca-e2e-home-',
  'playwright-artifacts-',
  'playwright-downloads-'
]

function command(program, args) {
  const result = runProcessSync({ program, args, timeoutMs: 15_000, maxOutputBytes: 65_536 })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error(`Receipt command failed: ${program}`)
  }
  return result.stdout.trim()
}

function filesBelow(directory) {
  if (!existsSync(directory)) {
    return []
  }
  const files = []
  const pending = [directory]
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(file)
      } else if (entry.isFile()) {
        files.push(file)
      } else if (entry.isSymbolicLink()) {
        throw new Error('Capture file manifest requires regular files without symbolic links')
      }
    }
  }
  return files.sort()
}

function temporaryDirectories() {
  return readdirSync(tmpdir(), { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && prefixes.some((prefix) => entry.name.startsWith(prefix))
    )
    .map((entry) => path.join(tmpdir(), entry.name))
    .sort()
}

function readProc(pid) {
  try {
    return {
      pid,
      status: 'unverifiable',
      cwd: readlinkSync(`/proc/${pid}/cwd`),
      command: readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim()
    }
  } catch {
    return { pid, status: existsSync(`/proc/${pid}`) ? 'unverifiable' : 'exited' }
  }
}

function processReceipt(row, remainingDirectories) {
  return {
    pid: row.pid,
    status: row.status,
    mentionsCheckout: row.command?.includes(root) ?? false,
    cwdWithinCapturedDirectory: remainingDirectories.some(
      (directory) => row.cwd === directory || row.cwd?.startsWith(`${directory}${path.sep}`)
    )
  }
}

function collectCatalog(suites) {
  return suites.flatMap((suite) => [
    ...(suite.specs ?? []).flatMap((spec) =>
      spec.tests.map((test) => ({
        title: spec.title,
        file: spec.file,
        project: test.projectName,
        id: test.testId
      }))
    ),
    ...collectCatalog(suite.suites ?? [])
  ])
}

function beforeCommand() {
  if (process.env.ORCA_LAYOUT_ORACLE_RECORD || process.env.ORCA_LAYOUT_ORACLE_REPEAT) {
    throw new Error('Capture requires the ordinary layout oracle mode and case count')
  }
  const stablyRequire = createRequire(require.resolve('@stablyai/playwright-test'))
  const testRequire = createRequire(stablyRequire.resolve('@playwright/test'))
  const playwrightRequire = createRequire(testRequire.resolve('playwright'))
  const corePackage = playwrightRequire.resolve('playwright-core/package.json')
  const core = readJson(corePackage)
  if (core.version !== '1.63.0') {
    throw new Error(`Capture requires E2E Playwright 1.63.0, found ${core.version}`)
  }
  const catalog = collectCatalog(readJson(path.join(directory, 'catalog.json')).suites)
  if (catalog.length !== 21 || catalog.some((test) => test.project !== 'electron-headless')) {
    throw new Error('Capture requires all 21 existing desktop layout cases')
  }
  const sourcePaths = [
    'pnpm-lock.yaml',
    '.github/workflows/e2e.yml',
    'tests/playwright.config.ts',
    'tests/e2e/workspace-layout-oracle.spec.ts',
    'tests/e2e/helpers/orca-restart.ts',
    'tests/e2e/helpers/electron-process-shutdown.ts',
    'tests/e2e/helpers/electron-close-stage-observation.mjs',
    'tests/e2e/helpers/electron-close-stage-methods.mjs',
    'config/scripts/ci-electron-close-capture-receipt.mjs'
  ]
  const builtFiles = filesBelow(path.join(root, 'out'))
  if (builtFiles.length === 0) {
    throw new Error('Capture requires the completed shared app build')
  }
  const nativeFiles = filesBelow(
    path.join(path.dirname(require.resolve('node-pty/package.json')), 'build')
  ).filter((file) => file.endsWith('.node'))
  if (nativeFiles.length === 0) {
    throw new Error('Capture requires the prepared native addon')
  }
  const receipt = {
    head: command('git', ['rev-parse', 'HEAD']),
    parents: command('git', ['show', '-s', '--format=%P', 'HEAD']),
    tree: command('git', ['rev-parse', 'HEAD^{tree}']),
    versions: {
      node: process.version,
      pnpm: command('pnpm', ['--version']),
      electron: readJson(require.resolve('electron/package.json')).version,
      playwrightCore: core.version
    },
    nodeExecutable: { path: process.execPath, sha256: hash(readFileSync(process.execPath)) },
    coreBundle: {
      path: path.join(path.dirname(corePackage), 'lib/coreBundle.js'),
      sha256: hash(readFileSync(path.join(path.dirname(corePackage), 'lib/coreBundle.js')))
    },
    source: Object.fromEntries(sourcePaths.map((file) => [file, hash(readFileSync(file))])),
    build: Object.fromEntries(
      builtFiles.map((file) => [path.relative(root, file), hash(readFileSync(file))])
    ),
    native: Object.fromEntries(
      nativeFiles.map((file) => [path.relative(root, file), hash(readFileSync(file))])
    ),
    catalog,
    temporaryDirectories: temporaryDirectories(),
    observerLimits:
      '256 events/close, 1MiB per module/worker process; replacements reset budget and closeIds'
  }
  save('before.json', receipt)
  console.log(
    JSON.stringify({
      phase: 'before',
      head: receipt.head,
      cases: catalog.length,
      buildFiles: builtFiles.length
    })
  )
}

function afterCommand() {
  const before = readJson(path.join(directory, 'before.json'))
  const log = readFileSync(path.join(directory, 'command.log'), 'utf8')
  const records = [...log.matchAll(/\[e2e:close-stage\] (\{[^\n]*\})/g)].map((match) =>
    JSON.parse(match[1])
  )
  const pids = [...new Set(records.flatMap((record) => [record.pid, record.workerPid]))].filter(
    (pid) => Number.isSafeInteger(pid) && pid > 0
  )
  const remainingDirectories = temporaryDirectories().filter(
    (file) => !before.temporaryDirectories.includes(file)
  )
  const processes = readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .map((name) => readProc(Number(name)))
  const related = processes.filter(
    (row) =>
      row.pid !== process.pid &&
      (row.command?.includes(root) ||
        processReceipt(row, remainingDirectories).cwdWithinCapturedDirectory)
  )
  save('after.json', {
    head: command('git', ['rev-parse', 'HEAD']),
    records: records.length,
    recordedProcesses: pids.map((pid) => ({
      ...processReceipt(readProc(pid), remainingDirectories),
      identityLimit:
        'Presence without the launch creation identity is unverifiable; absence establishes exited'
    })),
    relatedProcesses: related.map((row) => processReceipt(row, remainingDirectories)),
    remainingDirectories,
    protocolEvidence:
      'Read actual connection/socket/callback records; app-close alone does not prove launcher cleanup',
    cleanupPolicy:
      'Read-only receipt; no process, transport, handle or directory is stopped or removed'
  })
  console.log(
    JSON.stringify({
      phase: 'after',
      records: records.length,
      related: related.length,
      directories: remainingDirectories.length
    })
  )
}

if (process.platform !== 'linux' || process.env.CI !== 'true') {
  throw new Error('This temporary receipt is scoped to the isolated Linux CI capture')
}
if (mode === 'before') {
  beforeCommand()
} else if (mode === 'after') {
  afterCommand()
} else {
  throw new Error('Expected before or after')
}
