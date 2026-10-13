import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { runProcessSync } from '@orca/process-host'
import { removeTreeSync } from '../../src/shared/windows-transient-lock-removal.ts'

const roots = []
const executable = process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath

afterEach(() => {
  for (const root of roots.splice(0)) {
    removeTreeSync(root)
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-mobile-ci-launch-'))
  roots.push(root)
  const script = join(root, 'config', 'scripts', 'run-mobile-ci-tests.mjs')
  const host = join(root, 'node_modules', '@orca', 'process-host')
  const vitest = join(root, 'node_modules', 'vitest')
  const ownedTemp = join(root, 'temporary')
  for (const dir of [dirname(script), host, vitest, ownedTemp, join(root, 'mobile')]) {
    mkdirSync(dir, { recursive: true })
  }
  copyFileSync(resolve('config/scripts/run-mobile-ci-tests.mjs'), script)
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  writeFileSync(join(vitest, 'package.json'), '{"name":"vitest","version":"0.0.0"}')
  writeFileSync(join(vitest, 'vitest.mjs'), '')
  writeFileSync(join(host, 'package.json'), '{"type":"module","exports":"./index.mjs"}')
  writeFileSync(
    join(host, 'index.mjs'),
    `
    import { appendFileSync } from 'node:fs'
    export async function runProcess(spec) {
      const role = spec.args.includes('--bun') ? 'bun' : 'node'
      appendFileSync(process.env.COMMAND_LOG, JSON.stringify({
        role, args: spec.args, temp: spec.env.TMPDIR,
        background: spec.env.ORCA_BACKGROUND_LAUNCH,
        barrier: spec.terminationBarrier
      }) + '\\n')
      if (process.env.MISSING_CLOSURE !== role) spec.onChildTerminated()
      return { code: process.env.FAIL_ROLE === role ? 9 : 0 }
    }
  `
  )
  const log = join(root, 'calls.jsonl')
  function run(args = [], extraEnv = {}) {
    const result = runProcessSync({
      program: executable,
      args: [script, ...args],
      cwd: root,
      timeoutMs: 10_000,
      env: {
        ...process.env,
        ORCA_BACKGROUND_LAUNCH: '1',
        TMPDIR: ownedTemp,
        TMP: ownedTemp,
        TEMP: ownedTemp,
        COMMAND_LOG: log,
        ...extraEnv
      }
    })
    const calls = existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : []
    return { ...result, calls }
  }
  return { run }
}

it.each(['all', 'node', 'bun'])(
  'launches and cleans up exactly the %s runtime selection',
  (runtime) => {
    const { run } = fixture()
    const result = run([`--runtime=${runtime}`, '--reporter=dot'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.calls.map((call) => call.role)).toEqual(
      runtime === 'all' ? ['node', 'bun'] : [runtime]
    )
    for (const call of result.calls) {
      expect(call.background).toBe('1')
      expect(call.barrier).toBe(true)
      expect(call.args).toContain('--reporter=dot')
      expect(existsSync(call.temp)).toBe(false)
    }
  }
)

it('keeps both runtimes as the default for main and existing callers', () => {
  const result = fixture().run()
  expect(result.code, result.stderr).toBe(0)
  expect(result.calls.map((call) => call.role)).toEqual(['node', 'bun'])
})

it.each(['node', 'bun'])('propagates a %s failure while collecting both runtimes', (role) => {
  const result = fixture().run([], { FAIL_ROLE: role })
  expect(result.code).toBe(9)
  expect(result.calls).toHaveLength(2)
})

it('retains scratch data when a selected runtime has no confirmed closure', () => {
  const result = fixture().run(['--runtime=node'], { MISSING_CLOSURE: 'node' })
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('closure is unverifiable')
  expect(existsSync(result.calls[0].temp)).toBe(true)
})

it.each([['--runtime=other'], ['--runtime=node', '--runtime=bun'], ['--config=other']])(
  'rejects invalid selections or unapproved arguments: %s',
  (...args) => {
    const result = fixture().run(args)
    expect(result.code).not.toBe(0)
    expect(result.calls).toEqual([])
  }
)
