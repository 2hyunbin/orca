import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  issueCacheKey,
  prCacheKey,
  sourceScopedRepoCacheKey,
  workItemsCacheKey
} from '../github/cache-identity'
import { getHostedReviewCacheKey } from './hosted-review-cache-identity'
import {
  createTestStore,
  githubSourceContext,
  makePR,
  resetRemoteRuntimeMocks
} from './github-slice-test-harness'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { getTaskSourceCacheScope } from '../../../../shared/task-source-context'
import type { Repo } from '../../../../shared/repo-types'

const SSH_HOST = toSshExecutionHostId('builder')
const RUNTIME_HOST = 'runtime:paired'

const localRow: Repo = {
  id: 'twin',
  path: '/laptop/twin',
  displayName: 'Twin',
  badgeColor: '#000',
  addedAt: 1
}
// Why no executionHostId: older SSH rows carry only connectionId.
const sshRow: Repo = { ...localRow, path: '/remote/twin', addedAt: 2, connectionId: 'builder' }

/** Every repo-owned cache seeded with one entry per host scope, keyed by the real builders. */
function seedEveryHostScope(repoId: string, repoPath: string) {
  const entry = { data: [], fetchedAt: 1 }
  const hosts = { local: null, ssh: SSH_HOST, runtime: RUNTIME_HOST } as const
  const keys = Object.fromEntries(
    Object.entries(hosts).map(([name, hostId]) => [
      name,
      {
        workItems: workItemsCacheKey(repoId, 20, '', hostId),
        pr: prCacheKey(repoPath, repoId, 'main', null, null, hostId, true),
        issue: issueCacheKey(repoPath, repoId, 7, null, null, hostId, true),
        checks: sourceScopedRepoCacheKey(repoPath, repoId, 'pr-checks::7', null, null, hostId),
        hostedReview: getHostedReviewCacheKey(repoPath, 'main', null, repoId, null, hostId, true)
      }
    ])
  )
  const sourceKey = workItemsCacheKey(
    repoId,
    20,
    '',
    getTaskSourceCacheScope(githubSourceContext(SSH_HOST, repoId))
  )
  const all = Object.values(keys)
  return {
    keys,
    sourceKey,
    state: {
      workItemsCache: Object.fromEntries(
        [...all.map((k) => k.workItems), sourceKey].map((key) => [key, entry])
      ),
      prCache: Object.fromEntries(all.map((k) => [k.pr, { data: makePR(), fetchedAt: 1 }])),
      issueCache: Object.fromEntries(all.map((k) => [k.issue, { data: null, fetchedAt: 1 }])),
      checksCache: Object.fromEntries(all.map((k) => [k.checks, entry])),
      hostedReviewCache: Object.fromEntries(
        all.map((k) => [k.hostedReview, { data: null, fetchedAt: 1 }])
      )
    }
  }
}

function cachedKeys(store: ReturnType<typeof createTestStore>): string[] {
  const s = store.getState()
  return [s.workItemsCache, s.prCache, s.issueCache, s.checksCache, s.hostedReviewCache].flatMap(
    (cache) => Object.keys(cache)
  )
}

describe('repo cache eviction across host scopes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('evicting a repo clears its local, SSH-scoped and runtime-scoped entries, and no other repo’s', () => {
    const store = createTestStore()
    const removed = seedEveryHostScope('repo-1', '/repo/one')
    const other = seedEveryHostScope('repo-2', '/repo/two')
    store.setState({
      repos: [{ ...localRow, id: 'repo-1', path: '/repo/one' }],
      workItemsCache: { ...removed.state.workItemsCache, ...other.state.workItemsCache },
      prCache: { ...removed.state.prCache, ...other.state.prCache },
      issueCache: { ...removed.state.issueCache, ...other.state.issueCache },
      checksCache: { ...removed.state.checksCache, ...other.state.checksCache },
      hostedReviewCache: { ...removed.state.hostedReviewCache, ...other.state.hostedReviewCache }
    })

    store.getState().evictGitHubRepoCaches('repo-1', '/repo/one', 'local')

    expect(cachedKeys(store).sort()).toEqual(
      [
        ...Object.keys(other.state.workItemsCache),
        ...Object.keys(other.state.prCache),
        ...Object.keys(other.state.issueCache),
        ...Object.keys(other.state.checksCache),
        ...Object.keys(other.state.hostedReviewCache)
      ].sort()
    )
  })

  it('removing the SSH twin keeps the local twin’s entries, and the reverse', () => {
    const seeded = seedEveryHostScope('twin', localRow.path)
    const local = Object.values(seeded.keys.local)
    const ssh = [...Object.values(seeded.keys.ssh), seeded.sourceKey]

    const store = createTestStore()
    store.setState({ repos: [localRow, sshRow], ...seeded.state })
    store.getState().evictGitHubRepoCaches('twin', sshRow.path, SSH_HOST)
    expect(cachedKeys(store)).toEqual(expect.arrayContaining(local))
    expect(cachedKeys(store).filter((key) => ssh.includes(key))).toEqual([])

    const reverse = createTestStore()
    reverse.setState({ repos: [localRow, sshRow], ...seeded.state })
    reverse.getState().evictGitHubRepoCaches('twin', localRow.path, 'local')
    expect(cachedKeys(reverse)).toEqual(expect.arrayContaining(ssh))
    expect(cachedKeys(reverse).filter((key) => local.includes(key))).toEqual([])
  })

  it('without a host, evicts the bucket of the row at the request path', () => {
    const seeded = seedEveryHostScope('twin', localRow.path)
    const store = createTestStore()
    store.setState({ repos: [localRow, sshRow], ...seeded.state })

    store.getState().evictGitHubRepoCaches('twin', sshRow.path)

    expect(Object.keys(store.getState().workItemsCache)).toEqual([seeded.keys.local.workItems])
  })
})
