import { runProcess } from '@orca/process-host'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const require = createRequire(import.meta.url)
const cli = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
const args = process.argv.slice(2)
const selections = args.filter((argument) => argument.startsWith('--runtime='))
const runtime = selections[0]?.slice('--runtime='.length) ?? 'all'
if (selections.length > 1 || !['all', 'node', 'bun'].includes(runtime)) {
  throw new Error('Choose one mobile test runtime: all, node, or bun')
}
if (process.versions.bun) {
  throw new Error('Launch mobile CI tests with Node.js')
}
const shards = args.filter((argument) => argument.startsWith('--bun-shard='))
const bunShard = shards[0]?.slice('--bun-shard='.length)
if (
  shards.length > 1 ||
  (shards.length > 0 && (!['1/2', '2/2'].includes(bunShard) || runtime === 'node'))
) {
  throw new Error('Choose one Bun shard: 1/2 or 2/2, with a Bun runtime')
}
const reporters = args.filter(
  (argument) => !argument.startsWith('--runtime=') && !argument.startsWith('--bun-shard=')
)
if (reporters.some((argument) => !argument.startsWith('--reporter='))) {
  throw new Error('Only additional Vitest reporters are accepted')
}
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'orca-mobile-tests-')))
const roles = runtime === 'all' ? ['node', 'bun'] : [runtime]
const abort = new AbortController()
const closed = new Set()
let signalExitCode
const onInterrupt = () => {
  signalExitCode ??= 130
  abort.abort()
}
const onTerminate = () => {
  signalExitCode ??= 143
  abort.abort()
}
process.on('SIGINT', onInterrupt)
process.on('SIGTERM', onTerminate)

async function runRole(role, program, runtimeArgs) {
  const owned = join(scratch, role)
  let launched = false
  try {
    mkdirSync(owned)
    launched = true
    return await runProcess({
      program,
      args: [
        ...runtimeArgs,
        cli,
        'run',
        '--config',
        join(root, 'config/mobile-ci.vitest.config.mjs'),
        '--reporter=default',
        '--reporter=json',
        `--outputFile=${join(owned, 'results.json')}`,
        ...(role === 'bun' && bunShard ? [`--shard=${bunShard}`] : []),
        ...reporters
      ],
      cwd: join(root, 'mobile'),
      env: {
        ...process.env,
        TMPDIR: owned,
        TMP: owned,
        TEMP: owned,
        ORCA_BACKGROUND_LAUNCH: '1',
        ORCA_MOBILE_CI_CACHE_DIR: join(owned, 'cache')
      },
      stdio: 'inherit',
      timeoutMs: null,
      signal: abort.signal,
      terminationBarrier: true,
      onChildTerminated: () => closed.add(role)
    })
  } catch (error) {
    if (!launched) {
      closed.add(role)
    }
    abort.abort()
    throw error
  }
}

try {
  const results = await Promise.allSettled(
    roles.map((role) =>
      role === 'node' ? runRole(role, process.execPath, []) : runRole(role, 'bun', ['--bun'])
    )
  )
  let exitCode = 0
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error(result.reason)
      exitCode ||= 1
    } else if (result.value.code !== 0) {
      exitCode ||= result.value.code ?? 1
    }
  }
  process.exitCode = signalExitCode ?? exitCode
} finally {
  process.removeListener('SIGINT', onInterrupt)
  process.removeListener('SIGTERM', onTerminate)
  if (closed.size === roles.length) {
    rmSync(scratch, { recursive: true, force: true })
  } else {
    console.error(`Mobile test process closure is unverifiable; retained ${scratch}`)
    process.exitCode = signalExitCode ?? 1
  }
}
