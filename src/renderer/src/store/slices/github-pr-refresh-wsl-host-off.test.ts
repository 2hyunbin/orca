import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { createGitHubSlice } from './github'
import { createHostedReviewSlice } from './hosted-review'
import type { AppState } from '../types'
import type { PRInfo } from '../../../../shared/github/pull-request-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()
const enqueuePRRefresh = vi.fn().mockResolvedValue(undefined)
const reportVisiblePRRefreshCandidates = vi.fn().mockResolvedValue(true)

const mockApi = {
  gh: {
    prForBranch: vi.fn().mockResolvedValue(null),
    refreshPRNow: vi.fn().mockResolvedValue({ kind: 'no-pr', fetchedAt: 1 }),
    enqueuePRRefresh,
    reportVisiblePRRefreshCandidates,
    issue: vi.fn().mockResolvedValue(null)
  },
  hostedReview: { forBranch: vi.fn().mockResolvedValue(null) },
  runtimeEnvironments: { call: runtimeEnvironmentTransportCall },
  cache: {
    getGitHub: vi.fn().mockResolvedValue(null),
    setGitHub: vi.fn().mockResolvedValue(undefined)
  }
}

// @ts-expect-error test window mock
globalThis.window = { api: mockApi }

function resetRuntimeMocks(): void {
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
}

function createTestStore() {
  return create<AppState>()(
    (...a) =>
      ({
        ...createGitHubSlice(...a),
        ...createHostedReviewSlice(...a)
      }) as AppState
  )
}

function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 12,
    title: 'Test PR',
    state: 'open',
    url: 'https://example.com/pr/12',
    checksStatus: 'pending',
    updatedAt: '2026-03-28T00:00:00Z',
    mergeable: 'UNKNOWN',
    headSha: 'head-oid',
    ...overrides
  }
}

function makeRepo(overrides: Partial<Repo> & Pick<Repo, 'id' | 'path'>): Repo {
  return {
    displayName: overrides.id,
    badgeColor: 'blue',
    addedAt: 1,
    kind: 'git',
    gitRemoteIdentity: {
      canonicalKey: 'github.com/owner/repo',
      remoteName: 'origin',
      remoteUrl: 'https://github.com/owner/repo.git'
    },
    ...overrides
  }
}

function makeWorktree(repoId: string, branch: string, id = `${repoId}-wt`): Worktree {
  return {
    id,
    repoId,
    path: `/worktrees/${id}`,
    head: 'head-oid',
    branch,
    displayName: branch,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedLinearIssueWorkspaceId: null,
    linkedLinearIssueOrganizationUrlKey: null,
    isMainWorktree: false,
    isBare: false,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1
  }
}

function seed(
  store: ReturnType<typeof createTestStore>,
  state: Pick<AppState, 'repos' | 'worktreesByRepo'> & Partial<AppState>
): void {
  store.setState({
    settings: { activeRuntimeEnvironmentId: null } as AppState['settings'],
    groupBy: 'pr-status',
    worktreeCardProperties: ['status'],
    prCache: {},
    issueCache: {},
    hostedReviewCache: {},
    commentsCache: {},
    sshConnectionStates: new Map(),
    ...state
  } as unknown as Partial<AppState>)
}

const WSL_ENV: AppState['runtimeEnvironments'][number] = {
  id: 'env-1',
  name: 'Ubuntu (WSL)',
  createdAt: 0,
  updatedAt: 0,
  lastUsedAt: null,
  runtimeId: null,
  preferredEndpointId: 'ws',
  endpoints: [],
  orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 42000, remotePort: 6768 }
}

describe('PR refresh for a WSL host that is off (E9)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRuntimeMocks()
  })

  it('keeps the last badge, records host-off, and never asks the host', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: true,
      result: makePR({ number: 31 }),
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    seed(store, {
      repos: [makeRepo({ id: 'repo-wsl', path: '/home/me/app', executionHostId: 'runtime:env-1' })],
      worktreesByRepo: { 'repo-wsl': [makeWorktree('repo-wsl', 'feature/x', 'wt-wsl')] },
      runtimeEnvironments: [WSL_ENV],
      wslHostStatuses: {
        'env-1': { environmentId: 'env-1', distro: 'Ubuntu', state: 'ready', detail: null }
      }
    })
    store.getState().enqueueGitHubPRRefresh('wt-wsl', 'manual', 100)
    await vi.waitFor(() =>
      expect(
        Object.values(store.getState().prCache).some((entry) => entry.data?.number === 31)
      ).toBe(true)
    )

    store.setState({
      wslHostStatuses: {
        'env-1': { environmentId: 'env-1', distro: 'Ubuntu', state: 'distro-stopped', detail: null }
      }
    })
    store.getState().enqueueGitHubPRRefresh('wt-wsl', 'manual', 100)

    await vi.waitFor(() =>
      expect(Object.values(store.getState().prRefreshStates)).toContainEqual(
        expect.objectContaining({ status: 'skipped', skippedReason: 'host-off' })
      )
    )
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
    expect(Object.values(store.getState().prCache).map((entry) => entry.data?.number)).toEqual([31])
  })
})
