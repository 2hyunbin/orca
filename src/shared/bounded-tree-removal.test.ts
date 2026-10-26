import { sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  removeTreeWithBoundedRetries,
  TreeRemovalError,
  type TreeRemovalFs
} from './bounded-tree-removal'

type Entry = 'dir' | 'file' | 'link'

/** In-memory tree whose operations settle on later ticks, like libuv, and are counted. */
function memoryTree(entries: Record<string, Entry>, locked: Set<string>) {
  const tree = new Map<string, Entry>(Object.entries(entries))
  const stats = { calls: 0, inFlight: 0 }
  const fail = (code: string, path: string) =>
    Object.assign(new Error(`${code}: ${path}`), { code, path })
  const op =
    <A extends unknown[], R>(body: (path: string, ...rest: A) => R) =>
    async (path: string, ...rest: A): Promise<R> => {
      stats.calls += 1
      stats.inFlight += 1
      try {
        await new Promise((resolve) => setImmediate(resolve))
        return body(path, ...rest)
      } finally {
        stats.inFlight -= 1
      }
    }
  const children = (path: string) =>
    [...tree.keys()].filter(
      (candidate) =>
        candidate.startsWith(`${path}${sep}`) && !candidate.slice(path.length + 1).includes(sep)
    )
  const fs: TreeRemovalFs = {
    lstat: op((path) => {
      const entry = tree.get(path)
      if (!entry) {
        throw fail('ENOENT', path)
      }
      return { isDirectory: () => entry === 'dir' }
    }),
    readdir: op((path) => children(path).map((child) => child.slice(path.length + 1))),
    unlink: op((path) => {
      if (!tree.has(path)) {
        throw fail('ENOENT', path)
      }
      if (locked.has(path)) {
        throw fail('EBUSY', path)
      }
      tree.delete(path)
    }),
    rmdir: op((path) => {
      if (children(path).length > 0) {
        throw fail('ENOTEMPTY', path)
      }
      tree.delete(path)
    }),
    chmod: op(() => {})
  }
  return { fs, tree, stats }
}

const root = `${sep}profile`
const at = (...parts: string[]) => [root, ...parts].join(sep)

/** A live browser profile: a shallow lock file beside a deep chain of locked files. */
function lockedProfile(depth: number) {
  const entries: Record<string, Entry> = { [root]: 'dir', [at('lockfile')]: 'file' }
  const locked = new Set([at('lockfile')])
  const parts: string[] = []
  for (let level = 0; level < depth; level += 1) {
    parts.push(`d${level}`)
    entries[at(...parts)] = 'dir'
    entries[at(...parts, 'History')] = 'file'
    entries[at(...parts, 'cache.bin')] = 'file'
    locked.add(at(...parts, 'History'))
  }
  return { entries, locked }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('removeTreeWithBoundedRetries', () => {
  it('spends one shared retry budget on a tree with locked files and leaves nothing running', async () => {
    const { entries, locked } = lockedProfile(6)
    const { fs, tree, stats } = memoryTree(entries, locked)
    const retryDelaysMs = [1, 1, 1, 1]

    const error = await removeTreeWithBoundedRetries(root, fs, { retryDelaysMs }).catch(
      (caught: unknown) => caught
    )

    expect(error).toBeInstanceOf(TreeRemovalError)
    expect(error).toMatchObject({
      code: 'EBUSY',
      failures: { length: locked.size },
      message: expect.stringContaining('another process has them open')
    })
    expect(stats.inFlight).toBe(0)
    // Each pass touches every entry at most a few times; Node's per-entry retries grew ~9x per level.
    const passes = retryDelaysMs.length + 1
    expect(stats.calls).toBeLessThanOrEqual(passes * Object.keys(entries).length * 3)
    const callsAtRejection = stats.calls
    await settle()
    expect(stats.calls).toBe(callsAtRejection)
    expect([...tree.keys()].filter((path) => path.endsWith('cache.bin'))).toEqual([])
  })

  it('finishes the delete once a transient lock is released between passes', async () => {
    const { entries, locked } = lockedProfile(3)
    const { fs, tree } = memoryTree(entries, locked)

    const removal = removeTreeWithBoundedRetries(root, fs, { retryDelaysMs: [30, 30] })
    setTimeout(() => locked.clear(), 10)

    await expect(removal).resolves.toBeUndefined()
    expect(tree.size).toBe(0)
  })

  it('removes a directory link without deleting what it points at', async () => {
    const { fs, tree } = memoryTree(
      {
        [root]: 'dir',
        [at('node_modules')]: 'link',
        [`${sep}shared`]: 'dir',
        [`${sep}shared${sep}keep`]: 'file'
      },
      new Set()
    )

    await removeTreeWithBoundedRetries(root, fs, { retryDelaysMs: [] })

    expect([...tree.keys()].sort()).toEqual([`${sep}shared`, `${sep}shared${sep}keep`])
  })

  it('stops between operations once aborted and rejects only after in-flight work settles', async () => {
    const { entries, locked } = lockedProfile(6)
    const { fs, stats } = memoryTree(entries, locked)
    const controller = new AbortController()

    const removal = removeTreeWithBoundedRetries(root, fs, {
      retryDelaysMs: [60_000],
      signal: controller.signal
    })
    setTimeout(() => controller.abort(new Error('quit')), 5)

    await expect(removal).rejects.toThrow('quit')
    expect(stats.inFlight).toBe(0)
  })
})
