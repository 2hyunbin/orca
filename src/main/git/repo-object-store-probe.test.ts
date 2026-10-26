import { join } from 'node:path'
import type * as fs from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { openDirectory, git, version, locked } = vi.hoisted(() => ({
  openDirectory: vi.fn(),
  git: vi.fn(),
  version: vi.fn(),
  locked: vi.fn()
}))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
  opendir: openDirectory
}))
vi.mock('./runner', () => ({ gitExecFileAsync: git }))
vi.mock('./git-version', () => ({ readHostGitVersion: version }))
vi.mock('./repo-maintenance-locks', () => ({ isRepoMaintenanceLocked: locked }))

import { maintainRepoObjects, probeRepoObjectStore } from './repo-object-maintenance'
import { isObjectMaintenanceDue } from '../../shared/repo-object-maintenance-policy'

const root = join('repo', 'common')

function directory(count: number, name: (index: number) => string) {
  let visited = 0
  let closed = false
  return {
    entries: (async function* () {
      try {
        for (let index = 0; index < count; index += 1) {
          visited += 1
          yield { name: name(index) }
        }
      } finally {
        closed = true
      }
    })(),
    visited: () => visited,
    closed: () => closed
  }
}

beforeEach(() => vi.resetAllMocks())

describe('bounded object-store probes', () => {
  it.each([1000, 10000])('stops consuming entries at the trigger with %i files', async (count) => {
    const packs = directory(count, (index) => `pack-${index}.pack`)
    const loose = directory(count, (index) => index.toString(16).padStart(38, '0'))
    openDirectory.mockImplementation(async (path: string) =>
      path === join(root, 'objects', 'pack') ? packs.entries : loose.entries
    )
    const probe = await probeRepoObjectStore(root, new AbortController().signal)
    expect(probe).toEqual({ packCount: 50, looseObjects: 27 * 256 })
    expect(isObjectMaintenanceDue(probe)).toBe(true)
    expect(packs.visited()).toBe(50)
    expect(loose.visited()).toBe(27)
    expect(packs.closed()).toBe(true)
    expect(loose.closed()).toBe(true)
  })

  it('ignores non-object names and preserves the decision below and at the loose trigger', async () => {
    const signal = new AbortController().signal
    for (const count of [26, 27]) {
      const loose = directory(count * 2, (index) =>
        index % 2 === 0 ? index.toString(16).padStart(38, '0') : `temporary-${index}`
      )
      openDirectory.mockImplementation(async (path: string) =>
        path === join(root, 'objects', 'pack') ? directory(0, () => '').entries : loose.entries
      )
      const probe = await probeRepoObjectStore(root, signal)
      expect(probe.looseObjects).toBe(count * 256)
      expect(isObjectMaintenanceDue(probe)).toBe(count === 27)
      expect(loose.closed()).toBe(true)
    }
  })

  it('does no filesystem work when a probe is already canceled', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await probeRepoObjectStore(root, controller.signal)).toEqual({
      packCount: 0,
      looseObjects: 0
    })
    expect(openDirectory).not.toHaveBeenCalled()
  })

  it.each(['activity', 'cancellation'] as const)('defers before probing on %s', async (reason) => {
    const controller = new AbortController()
    if (reason === 'cancellation') {
      controller.abort()
    }
    expect(
      await maintainRepoObjects({
        repoPath: root,
        commonDir: root,
        signal: controller.signal,
        span: { setAttribute: () => {} },
        canWrite: () => reason !== 'activity'
      })
    ).toBe('deferred')
    expect(openDirectory).not.toHaveBeenCalled()
    expect(git).not.toHaveBeenCalled()
    expect(version).not.toHaveBeenCalled()
    expect(locked).not.toHaveBeenCalled()
  })
})
