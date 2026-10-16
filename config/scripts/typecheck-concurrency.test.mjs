import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  parseTypecheckOptions,
  runTypecheckProjects,
  typecheckBatches,
  TYPECHECK_PROJECTS
} from './run-typecheck-projects-in-parallel.mjs'

describe('typecheck resource options', () => {
  it('keeps existing local and CI defaults without resource overrides', () => {
    expect(parseTypecheckOptions([], {})).toMatchObject({
      compiler: 'native',
      concurrency: undefined,
      threads: undefined,
      bunConcurrency: 1,
      bunThreads: 4
    })
    expect(
      parseTypecheckOptions(['--compiler=bun', '--bun-concurrency=2', '--bun-threads=2'], {})
    ).toMatchObject({ compiler: 'bun', concurrency: undefined, bunConcurrency: 2, bunThreads: 2 })
  })

  it('uses shared build limits and lets command-line flags override their defaults', () => {
    const env = { ORCA_BUILD_CONCURRENCY: '1', ORCA_BUILD_THREADS: '1' }
    expect(parseTypecheckOptions([], env)).toMatchObject({
      concurrency: 1,
      threads: 1,
      bunThreads: 1
    })
    expect(parseTypecheckOptions(['--concurrency=2', '--bun-threads=3'], env)).toMatchObject({
      concurrency: 2,
      threads: 1,
      bunThreads: 3
    })
    expect(parseTypecheckOptions([], { ORCA_BUILD_THREADS: '8' }).bunThreads).toBe(4)
  })

  it.each(['0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992', ''])(
    'rejects invalid resource limits: %s',
    (value) => {
      expect(() => parseTypecheckOptions([`--concurrency=${value}`], {})).toThrow('concurrency')
      expect(() => parseTypecheckOptions([], { ORCA_BUILD_CONCURRENCY: value })).toThrow(
        'concurrency'
      )
      expect(() => parseTypecheckOptions([], { ORCA_BUILD_THREADS: value })).toThrow('threads')
    }
  )

  it.each(['native', 'bun'])(
    'keeps %s admission within CPU, memory and requested limits',
    (compiler) => {
      const options = { compiler, concurrency: 2, bunConcurrency: 4, parallelism: 8 }
      for (const memoryGib of [4, 64]) {
        const batches = typecheckBatches(TYPECHECK_PROJECTS, {
          ...options,
          memoryBytes: memoryGib * 1024 ** 3
        })
        expect(batches.every((batch) => batch.length <= 2)).toBe(true)
        expect(batches.flat()).toHaveLength(TYPECHECK_PROJECTS.length)
        for (const batch of batches) {
          const reserved = batch.reduce((sum, project) => sum + project.heapGib, 0)
          expect(reserved <= memoryGib * 0.75 || batch.length === 1).toBe(true)
        }
      }
      expect(
        typecheckBatches(TYPECHECK_PROJECTS, {
          ...options,
          concurrency: 8,
          parallelism: 1,
          memoryBytes: 64 * 1024 ** 3
        }).every((batch) => batch.length === 1)
      ).toBe(true)
    }
  )
})

describe('typecheck compiler resource limits', () => {
  it.each(['native', 'bun'])(
    'never exceeds the %s process limit while draining work',
    async (compiler) => {
      const children = []
      let active = 0
      let peak = 0
      const result = runTypecheckProjects({
        compiler,
        concurrency: 1,
        bunConcurrency: 4,
        bunThreads: 1,
        threads: 1,
        env: { TEST_RESOURCE_MARKER: 'preserved' },
        memoryBytes: 64 * 1024 ** 3,
        parallelism: 8,
        spawnCompiler: (spec) => {
          const child = new EventEmitter()
          children.push({ child, spec })
          peak = Math.max(peak, ++active)
          child.once('close', () => {
            active--
          })
          return child
        }
      })
      for (let index = 0; index < TYPECHECK_PROJECTS.length; index++) {
        await vi.waitFor(() => expect(children).toHaveLength(index + 1))
        expect(active).toBe(1)
        children[index].child.emit('close', 0, null)
      }
      expect(await result).toEqual([])
      expect(peak).toBe(1)
      expect(children.every(({ spec }) => spec.env.GOMAXPROCS === '1')).toBe(true)
      expect(children.every(({ spec }) => spec.env.TEST_RESOURCE_MARKER === 'preserved')).toBe(true)
    }
  )

  it('preserves an explicit Go runtime limit', async () => {
    const specs = []
    const result = await runTypecheckProjects({
      threads: 1,
      env: { GOMAXPROCS: '3' },
      spawnCompiler: (spec) => {
        specs.push(spec)
        const child = new EventEmitter()
        queueMicrotask(() => child.emit('close', 0, null))
        return child
      }
    })
    expect(result).toEqual([])
    expect(specs.every((spec) => spec.env.GOMAXPROCS === '3')).toBe(true)
  })
})
