import { describe, expect, it, vi } from 'vitest'
import { leanCommandEnv, runLeanCommand } from './run-lean-command.mjs'

describe('lean command resource budget', () => {
  it('limits native threads, test workers and simultaneous typecheck projects', () => {
    expect(leanCommandEnv({ PATH: 'preserved' })).toEqual({
      PATH: 'preserved',
      ORCA_BUILD_THREADS: '2',
      ORCA_BUILD_CONCURRENCY: '1',
      ORCA_TEST_MAX_WORKERS: '2',
      RAYON_NUM_THREADS: '2',
      GOMAXPROCS: '2'
    })
  })

  it('preserves explicit budgets and Node options', () => {
    const env = {
      ORCA_BUILD_THREADS: '3',
      ORCA_BUILD_CONCURRENCY: '2',
      ORCA_TEST_MAX_WORKERS: '1',
      RAYON_NUM_THREADS: '1',
      GOMAXPROCS: '4',
      NODE_OPTIONS: '--max-old-space-size=2048'
    }
    expect(leanCommandEnv(env)).toEqual(env)
    expect(env).not.toHaveProperty('ORCA_BACKGROUND_LAUNCH')
    expect(leanCommandEnv({ ORCA_BUILD_THREADS: '1' })).toMatchObject({
      RAYON_NUM_THREADS: '1',
      GOMAXPROCS: '1'
    })
  })

  it('forwards script arguments, cancellation and failure without a shell', async () => {
    const signal = new AbortController().signal
    const failure = { code: 7, signal: null }
    const run = vi.fn().mockResolvedValue(failure)
    expect(
      await runLeanCommand(['--', 'test', 'a file.test.ts', '--maxWorkers=1'], {
        env: { ORCA_BACKGROUND_LAUNCH: '1' },
        run,
        signal
      })
    ).toBe(failure)
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        program: 'pnpm',
        args: ['run', 'test', 'a file.test.ts', '--maxWorkers=1'],
        env: expect.objectContaining({ ORCA_BACKGROUND_LAUNCH: '1', ORCA_TEST_MAX_WORKERS: '2' }),
        stdio: 'inherit',
        timeoutMs: null,
        signal
      })
    )
  })

  it.each([{ args: [] }, { args: ['--'] }, { args: ['--help'] }])(
    'rejects a missing script: $args',
    async ({ args }) => {
      const run = vi.fn()
      await expect(runLeanCommand(args, { run })).rejects.toThrow('Usage: pnpm lean')
      expect(run).not.toHaveBeenCalled()
    }
  )
})
