import './rpc/unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { Repo } from '../../shared/repo-types'
import type { DetectedWorktreeListResult } from '../../shared/worktree/types'

describe('detected workspace listing during repo resolution', () => {
  it('captures the listing method before awaiting resolution and keeps its runtime receiver', async () => {
    const pending = Promise.withResolvers<Repo>()
    const events: string[] = []
    const repo: Repo = {
      id: 'repo',
      path: '/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 0
    }
    const result: DetectedWorktreeListResult = {
      repoId: repo.id,
      authoritative: true,
      source: 'git',
      worktrees: []
    }
    const runtime = new (class extends OrcaRuntimeService {
      override resolveRepoSelectorForConnection(selector: string, connectionId?: string | null) {
        events.push('resolve')
        expect([selector, connectionId]).toEqual(['repo', 'ssh:box'])
        return pending.promise
      }
    })()
    const original = vi.fn(function (
      this: OrcaRuntimeService,
      resolved: Repo,
      sourceDefaultsSupported?: boolean
    ) {
      events.push('invoke original')
      expect(this).toBe(runtime)
      expect([resolved, sourceDefaultsSupported]).toEqual([repo, false])
      return Promise.resolve(result)
    })
    const replacement = vi.fn(() => Promise.resolve({ ...result, repoId: 'replacement' }))
    let listing: (
      repo: Repo,
      sourceDefaultsSupported?: boolean
    ) => Promise<DetectedWorktreeListResult> = original
    Object.defineProperty(runtime, 'listDetectedWorktreesForResolvedRepo', {
      get: () => {
        events.push('capture listing')
        return listing
      }
    })

    const listingPromise = runtime.listDetectedManagedWorktrees('repo', 'ssh:box', false)
    listing = replacement
    pending.resolve(repo)

    await expect(listingPromise).resolves.toBe(result)
    expect(events).toEqual(['capture listing', 'resolve', 'invoke original'])
    expect(original).toHaveBeenCalledOnce()
    expect(replacement).not.toHaveBeenCalled()
  })
})

describe('workspace methods captured before request property reads', () => {
  it('captures port probes before reading repoId', async () => {
    const runtime = new OrcaRuntimeService()
    const events: string[] = []
    const original = vi.fn(async () => [])
    const replacement = vi.fn(async () => [])
    let probes = original
    Object.defineProperty(runtime, 'getWorkspacePortProbes', {
      get: () => {
        events.push('capture probes')
        return probes
      }
    })
    await runtime.killWorkspacePort({
      pid: 4242,
      port: 3020,
      get repoId() {
        events.push('read repoId')
        probes = replacement
        return 'repo'
      }
    })
    expect(events).toEqual(['capture probes', 'read repoId'])
    expect(original).toHaveBeenCalledWith('repo')
    expect(original.mock.contexts[0]).toBe(runtime)
    expect(replacement).not.toHaveBeenCalled()
  })

  it('captures file routing before reading the requested workspace', async () => {
    const runtime = new OrcaRuntimeService()
    const events: string[] = []
    const original = vi.fn(async () => ({ executionHostId: 'ssh:box' }))
    const replacement = vi.fn(async () => ({ executionHostId: 'ssh:box' }))
    let routing = original
    Object.defineProperty(runtime, 'resolveRuntimeFileTarget', {
      get: () => {
        events.push('capture routing')
        return routing
      }
    })
    await runtime.killWorkspacePortOnHost({
      executionHostId: 'ssh:box',
      pid: 4242,
      port: 3020,
      get worktree() {
        events.push('read worktree')
        routing = replacement
        return 'folder:remote'
      }
    })
    expect(events).toEqual(['capture routing', 'read worktree'])
    expect(original).toHaveBeenCalledWith('folder:remote')
    expect(original.mock.contexts[0]).toBe(runtime)
    expect(replacement).not.toHaveBeenCalled()
  })

  it('captures scan invalidation before reading the resolved repo id', async () => {
    const runtime = new OrcaRuntimeService()
    const events: string[] = []
    const original = vi.fn()
    const replacement = vi.fn()
    let invalidate = original
    const repo: Repo = {
      get id() {
        events.push('read repo id')
        invalidate = replacement
        return 'repo'
      },
      path: '/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 0
    }
    Object.defineProperty(runtime, 'invalidateWorktreeScanCacheForRepo', {
      get: () => {
        events.push('capture invalidation')
        return invalidate
      }
    })
    Object.defineProperty(runtime, 'resolveRepoSelectorForConnection', {
      value: async () => repo
    })
    const detected: DetectedWorktreeListResult = {
      repoId: 'repo',
      authoritative: false,
      source: 'metadata-fallback',
      worktrees: []
    }
    Object.defineProperty(runtime, 'listDetectedWorktreesForResolvedRepo', {
      value: async () => detected
    })

    await expect(runtime.teardownMissingManagedWorktreeTerminals('repo', [])).resolves.toEqual({
      stoppedWorktreeIds: []
    })
    expect(events).toEqual(['capture invalidation', 'read repo id'])
    expect(original).toHaveBeenCalledWith('repo')
    expect(original.mock.contexts[0]).toBe(runtime)
    expect(replacement).not.toHaveBeenCalled()
  })
})
