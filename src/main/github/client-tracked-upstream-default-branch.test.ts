// #26948: tracking a base branch must not attach its integration PR to a feature branch.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GitHubEnterpriseRepositoryModule from './github-enterprise-repository'

const { clientMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./client-test-mocks')
  return { clientMocks: moduleMocks.createGitHubClientMocks(), moduleMocks }
})

vi.mock('./gh-utils', () => moduleMocks.ghUtilsModuleMock(clientMocks))
vi.mock('../git/runner', () => moduleMocks.gitRunnerModuleMock(clientMocks))
vi.mock('../providers/ssh-git-dispatch', () => moduleMocks.sshGitDispatchModuleMock(clientMocks))
vi.mock('./local-git-config-signature', () =>
  moduleMocks.localGitConfigSignatureModuleMock(clientMocks)
)
vi.mock('./github-enterprise-repository', async (importOriginal) =>
  moduleMocks.githubEnterpriseRepositoryModuleMock(
    await importOriginal<typeof GitHubEnterpriseRepositoryModule>()
  )
)
vi.mock('./rate-limit', () => moduleMocks.rateLimitModuleMock(clientMocks))
vi.mock('./github-api-repository', async (importOriginal) =>
  moduleMocks.githubApiRepositoryModuleMock(
    clientMocks,
    await importOriginal<typeof GithubApiRepositoryModule>()
  )
)

import { getPRForBranch } from './client/lookup/get-pr-for-branch'
import { getPRForBranchOutcome } from './client/lookup/pr-for-branch-outcome'
import { resetPRForBranchMocks } from './client-test-harness'
import type { RestPullRequest } from './client/lookup/pull-request-lookup-data'
import type { OwnerRepo } from './gh-utils'

const {
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getOwnerRepoForRemoteMock,
  resolvePRRepositoryCandidatesMock,
  gitExecFileAsyncMock
} = clientMocks

const ACME = { owner: 'acme', repo: 'widgets' }
const UPSTREAM = { owner: 'stablyai', repo: 'widgets' }
const CONTRIBUTOR = { owner: 'contributor', repo: 'widgets' }

/** remoteHeads maps a remote to the branch its `refs/remotes/<remote>/HEAD` points at. */
function primeGit(
  trackedUpstream: string,
  remoteHeads: Record<string, string> = { origin: 'develop' }
): void {
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'for-each-ref' && args.includes('--format=%(refname)%00%(upstream)')) {
      return { stdout: `refs/heads/feature/my-change\0${trackedUpstream}\n`, stderr: '' }
    }
    if (args[0] === 'for-each-ref' && args.includes('--format=%(refname)%00%(symref)')) {
      const stdout = Object.entries(remoteHeads)
        .filter(([remote]) => args.includes(`refs/remotes/${remote}/HEA[D]`))
        .map(
          ([remote, branch]) => `refs/remotes/${remote}/HEAD\0refs/remotes/${remote}/${branch}\n`
        )
        .join('')
      return { stdout, stderr: '' }
    }
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return { stdout: 'feature-head-oid\n', stderr: '' }
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`)
  })
}

function restPR(
  headRefName = 'develop',
  headRepo: OwnerRepo = ACME,
  prRepo: OwnerRepo = ACME
): RestPullRequest {
  return {
    number: 7,
    title: 'Release develop',
    state: 'closed',
    merged_at: null,
    html_url: `https://github.com/${prRepo.owner}/${prRepo.repo}/pull/7`,
    updated_at: '2025-01-01T00:00:00Z',
    draft: false,
    mergeable: null,
    base: { ref: 'release', sha: 'release-oid' },
    head: {
      ref: headRefName,
      sha: 'old-develop-oid',
      repo: { name: headRepo.repo, owner: { login: headRepo.owner } }
    }
  }
}

function primeGh(
  listsByHead: Record<string, RestPullRequest[]>,
  exactPR: RestPullRequest = Object.values(listsByHead).flat()[0] ?? restPR()
): void {
  const prsByNumber = new Map(
    [...Object.values(listsByHead).flat(), exactPR].map((pr) => [pr.number, pr])
  )
  ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    const head = args[1]?.match(/pulls\?head=([^&]+)/)?.[1]
    if (args[0] === 'api' && head) {
      return { stdout: JSON.stringify(listsByHead[decodeURIComponent(head)] ?? []) }
    }
    const exact = prsByNumber.get(Number(args[2]))
    if (args[0] === 'pr' && args[1] === 'view' && exact) {
      return {
        stdout: JSON.stringify({
          number: exact.number,
          title: exact.title,
          state: exact.merged_at ? 'MERGED' : exact.state.toUpperCase(),
          url: exact.html_url,
          statusCheckRollup: [],
          updatedAt: exact.updated_at,
          isDraft: exact.draft,
          mergeable: 'UNKNOWN',
          baseRefName: exact.base?.ref,
          headRefName: exact.head?.ref,
          baseRefOid: exact.base?.sha,
          headRefOid: exact.head?.sha,
          headRepositoryOwner: exact.head?.repo?.owner,
          headRepository: exact.head?.repo ? { name: exact.head.repo.name } : null
        })
      }
    }
    throw new Error(`gh unavailable: ${args.join(' ')}`)
  })
}

/** A fork clone: `origin` is the fork, `upstream` is the repo PRs target. */
function primeForkWithUpstream(): void {
  resolvePRRepositoryCandidatesMock.mockResolvedValue({
    candidates: [UPSTREAM, ACME],
    headRepo: ACME
  })
  getOwnerRepoForRemoteMock.mockImplementation(async (_repoPath: string, remoteName: string) =>
    remoteName === 'upstream' ? UPSTREAM : remoteName === 'origin' ? ACME : null
  )
}

describe('issue #26948: a branch tracking the default branch', () => {
  beforeEach(() => {
    resetPRForBranchMocks(clientMocks)
    getOwnerRepoMock.mockResolvedValue(ACME)
  })

  it('does not attach a PR whose head is the default branch', async () => {
    primeGit('refs/remotes/origin/develop')
    primeGh({ 'acme:develop': [restPR('develop')] })

    const pr = await getPRForBranch('/repo-root', 'feature/my-change')

    expect(pr).toBeNull()
  })

  it('drops a cached PR number whose head is the tracked default branch', async () => {
    primeGit('refs/remotes/origin/develop')
    primeGh({})

    const outcome = await getPRForBranchOutcome('/repo-root', 'feature/my-change', null, null, 7)

    expect(outcome.kind).toBe('no-pr')
  })

  it('skips the default branch on a second remote that PRs target (fork checkout off upstream)', async () => {
    primeForkWithUpstream()
    primeGit('refs/remotes/upstream/develop', { origin: 'develop', upstream: 'develop' })
    primeGh({ 'stablyai:develop': [restPR('develop', UPSTREAM, UPSTREAM)] })

    const pr = await getPRForBranch('/repo-root', 'feature/my-change')

    expect(pr).toBeNull()
  })

  it("uses the tracked remote's own default branch when it differs from origin's", async () => {
    primeForkWithUpstream()
    primeGit('refs/remotes/upstream/develop', { origin: 'main', upstream: 'develop' })
    primeGh({ 'stablyai:develop': [restPR('develop', UPSTREAM, UPSTREAM)] })

    const pr = await getPRForBranch('/repo-root', 'feature/my-change')

    expect(pr).toBeNull()
  })

  it("keeps a PR headed by a tracked branch that is only origin's default", async () => {
    primeForkWithUpstream()
    primeGit('refs/remotes/upstream/develop', { origin: 'develop', upstream: 'main' })
    primeGh({ 'stablyai:develop': [restPR('develop', UPSTREAM, UPSTREAM)] })

    const pr = await getPRForBranch('/repo-root', 'feature/my-change')

    expect(pr).toMatchObject({ number: 7 })
  })

  it("still follows a contributor fork's branch that shares the default branch's name", async () => {
    getOwnerRepoForRemoteMock.mockImplementation(async (_repoPath: string, remoteName: string) =>
      remoteName === 'contributor' ? { owner: 'contributor', repo: 'widgets' } : ACME
    )
    primeGit('refs/remotes/contributor/develop')
    primeGh({ 'contributor:develop': [{ ...restPR('develop', CONTRIBUTOR), state: 'open' }] })

    const pr = await getPRForBranch('/repo-root', 'feature/my-change')

    expect(pr).toMatchObject({ number: 7, headRepo: { owner: 'contributor', repo: 'widgets' } })
  })

  it('preserves a cached contributor PR sharing the tracked default branch name', async () => {
    primeGit('refs/remotes/origin/develop')
    primeGh({}, { ...restPR('develop', CONTRIBUTOR), state: 'open' })
    const pr = await getPRForBranch('/repo-root', 'feature/my-change', null, null, 7)
    expect(pr).toMatchObject({ number: 7, headRepo: CONTRIBUTOR })
  })

  it('preserves a PR from the origin fork default branch into upstream', async () => {
    primeForkWithUpstream()
    primeGit('refs/remotes/origin/develop')
    primeGh({ 'acme:develop': [{ ...restPR('develop', ACME, UPSTREAM), state: 'open' }] })
    const pr = await getPRForBranch('/repo-root', 'feature/my-change')
    expect(pr).toMatchObject({ number: 7, headRepo: ACME, prRepo: UPSTREAM })
  })

  it('clears an old cached integration PR after upstream tracking is removed', async () => {
    primeGit('')
    primeGh({})
    expect(
      (await getPRForBranchOutcome('/repo-root', 'feature/my-change', null, null, 7)).kind
    ).toBe('no-pr')
  })

  it('tries the cached feature PR after rejecting an unrelated upstream result', async () => {
    primeGit('refs/remotes/origin/develop')
    primeGh(
      { 'acme:develop': [restPR()] },
      { ...restPR('feature/my-change'), number: 8, state: 'open' }
    )
    const pr = await getPRForBranch('/repo-root', 'feature/my-change', null, null, 8)
    expect(pr).toMatchObject({ number: 8, headRefName: 'feature/my-change' })
  })

  it('does not borrow origin default when upstream HEAD is unknown', async () => {
    primeForkWithUpstream()
    primeGit('refs/remotes/upstream/develop', { origin: 'develop' })
    primeGh({ 'stablyai:develop': [restPR('develop', UPSTREAM, UPSTREAM)] })
    expect(await getPRForBranch('/repo-root', 'feature/my-change')).toMatchObject({ number: 7 })
  })

  it('uses PR head default metadata when upstream has no recorded HEAD', async () => {
    primeForkWithUpstream()
    primeGit('refs/remotes/upstream/develop', { origin: 'main' })
    const pr = restPR('develop', UPSTREAM, UPSTREAM)
    primeGh({
      'stablyai:develop': [
        {
          ...pr,
          head: {
            ...pr.head,
            repo: { name: 'widgets', owner: { login: 'stablyai' }, default_branch: 'develop' }
          }
        }
      ]
    })
    expect(await getPRForBranch('/repo-root', 'feature/my-change')).toBeNull()
  })

  it('preserves explicit links to integration PRs', async () => {
    primeGit('refs/remotes/origin/develop')
    primeGh({})
    expect(await getPRForBranch('/repo-root', 'feature/my-change', 7)).toMatchObject({ number: 7 })
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('preserves cached review context while detached', async () => {
    primeGh({})
    expect(await getPRForBranch('/repo-root', '', null, null, 7)).toMatchObject({ number: 7 })
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('does not infer a head repository for a cached PR with unavailable fork metadata', async () => {
    primeGit('refs/remotes/origin/develop')
    const pr = restPR()
    primeGh({}, { ...pr, head: { ref: 'develop', sha: 'deleted-fork-oid', repo: null } })
    expect(await getPRForBranch('/repo-root', 'feature/my-change', null, null, 7)).toMatchObject({
      number: 7
    })
  })

  it('does not fetch the rejected integration PR twice when its number is cached', async () => {
    primeGit('refs/remotes/origin/develop')
    primeGh({ 'acme:develop': [restPR()] })
    expect(await getPRForBranch('/repo-root', 'feature/my-change', null, null, 7)).toBeNull()
    const exactCalls = ghExecFileAsyncMock.mock.calls.filter(
      ([args]) => args[0] === 'pr' && args[1] === 'view'
    )
    expect(exactCalls).toHaveLength(1)
  })
})
