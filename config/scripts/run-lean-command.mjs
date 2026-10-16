import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProcess } from '@orca/process-host'

export function leanCommandEnv(env = process.env) {
  const threads = env.ORCA_BUILD_THREADS ?? '2'
  return {
    ORCA_BUILD_THREADS: threads,
    ORCA_BUILD_CONCURRENCY: '1',
    ORCA_TEST_MAX_WORKERS: '2',
    ...env,
    RAYON_NUM_THREADS: env.RAYON_NUM_THREADS ?? threads,
    GOMAXPROCS: env.GOMAXPROCS ?? threads
  }
}

export async function runLeanCommand(args, { env = process.env, run = runProcess, signal } = {}) {
  if (args[0] === '--') {
    args = args.slice(1)
  }
  if (args.length === 0 || args[0].startsWith('-')) {
    throw new Error(
      'Usage: pnpm lean <script> [arguments], e.g. pnpm lean dev or pnpm lean test <file>'
    )
  }
  return run({
    program: 'pnpm',
    args: ['run', ...args],
    cwd: resolve(import.meta.dirname, '../..'),
    env: leanCommandEnv(env),
    stdio: 'inherit',
    timeoutMs: null,
    signal
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController()
  let interruptedCode
  const onInterrupt = () => {
    interruptedCode = 130
    controller.abort()
  }
  const onTerminate = () => {
    interruptedCode = 143
    controller.abort()
  }
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onTerminate)
  try {
    const result = await runLeanCommand(process.argv.slice(2), { signal: controller.signal })
    process.exitCode = interruptedCode ?? result.code ?? 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  } finally {
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onTerminate)
  }
}
