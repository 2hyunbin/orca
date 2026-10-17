import { describe, expect, it } from 'vitest'
import { WorkspaceCreationRegistry } from './workspace-creation-registry'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('WorkspaceCreationRegistry', () => {
  it('lists a creation while it runs, names its workspace, and drops it when it settles', async () => {
    const registry = new WorkspaceCreationRegistry()
    const gate = deferred<string>()
    let name: (worktreeId: string) => void = () => {}
    const run = registry.track({ creationId: 'c1', repoId: 'repo-1' }, (named) => {
      name = named
      return gate.promise
    })
    expect(registry.snapshot().creations).toEqual({ c1: { repoId: 'repo-1' } })
    const opened = registry.snapshot().revision

    name('repo-1::/wt')
    expect(registry.snapshot().creations).toEqual({
      c1: { repoId: 'repo-1', worktreeId: 'repo-1::/wt' }
    })
    expect(registry.snapshot().revision).toBeGreaterThan(opened)

    gate.resolve('done')
    await expect(run).resolves.toBe('done')
    expect(registry.snapshot().creations).toEqual({})
  })

  it('drops a failed creation and rethrows', async () => {
    const registry = new WorkspaceCreationRegistry()
    const run = registry.track({ creationId: 'c1', repoId: 'repo-1' }, async () => {
      throw new Error('git failed')
    })
    await expect(run).rejects.toThrow('git failed')
    expect(registry.snapshot().creations).toEqual({})
  })

  it('mints an id for a caller that sends none', async () => {
    const registry = new WorkspaceCreationRegistry()
    const gate = deferred<void>()
    const run = registry.track({ repoId: 'repo-1' }, () => gate.promise)
    const ids = Object.keys(registry.snapshot().creations)
    expect(ids).toHaveLength(1)
    expect(ids[0]).not.toBe('')
    gate.resolve()
    await run
    expect(registry.snapshot().creations).toEqual({})
  })

  it('leaves a concurrent retry under the same id listed when the first run settles', async () => {
    const registry = new WorkspaceCreationRegistry()
    const first = deferred<void>()
    const second = deferred<void>()
    let nameFirst: (worktreeId: string) => void = () => {}
    const firstRun = registry.track({ creationId: 'c1', repoId: 'repo-1' }, (named) => {
      nameFirst = named
      return first.promise
    })
    const secondRun = registry.track({ creationId: 'c1', repoId: 'repo-1' }, () => second.promise)

    nameFirst('repo-1::/stale')
    first.reject(new Error('superseded'))
    await expect(firstRun).rejects.toThrow('superseded')
    expect(registry.snapshot().creations).toEqual({ c1: { repoId: 'repo-1' } })

    second.resolve()
    await secondRun
    expect(registry.snapshot().creations).toEqual({})
  })
})
