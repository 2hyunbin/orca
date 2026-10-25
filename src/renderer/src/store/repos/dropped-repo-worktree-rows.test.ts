import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore, makeTab, makeWorktree, seedStore } from '../slices/store-test-helpers'

const SERVER = toRuntimeExecutionHostId('env-1')

function serverRepo(id: string): Repo {
  return {
    id,
    path: '/srv/app',
    displayName: 'app',
    badgeColor: '#737373',
    addedAt: 1,
    executionHostId: SERVER
  }
}

let serverRepos: Repo[] = []
const call = vi.fn((args: RuntimeEnvironmentCallRequest) => {
  const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
  if (compatible) {
    return compatible
  }
  const result = args.method === 'repo.list' ? { repos: structuredClone(serverRepos) } : {}
  return { id: `rpc-${args.method}`, ok: true, result, _meta: { runtimeId: 'remote-runtime' } }
})

describe('a fetched catalog that drops a repo registration', () => {
  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    call.mockClear()
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call, list: vi.fn().mockResolvedValue([]) } },
      dispatchEvent: vi.fn()
    })
  })

  it('drops that host’s rows when the server relists its checkout under a new repo id', async () => {
    const store = createTestStore()
    const localTwin: Repo = { ...serverRepo('old'), path: '/local/app', executionHostId: 'local' }
    seedStore(store, {
      repos: [serverRepo('old'), localTwin],
      worktreesByRepo: {
        old: [
          makeWorktree({ id: 'old::/srv/app', repoId: 'old', path: '/srv/app', hostId: SERVER }),
          makeWorktree({
            id: 'old::/local/app',
            repoId: 'old',
            path: '/local/app',
            hostId: 'local'
          }),
          makeWorktree({ id: 'old::/legacy', repoId: 'old', path: '/legacy' })
        ]
      },
      activeWorktreeId: 'old::/srv/app',
      tabsByWorktree: {
        'old::/srv/app': [makeTab({ id: 'server-tab', worktreeId: 'old::/srv/app' })],
        'old::/local/app': [makeTab({ id: 'local-tab', worktreeId: 'old::/local/app' })]
      }
    })
    serverRepos = [serverRepo('copied')]

    await store.getState().fetchRuntimeEnvironmentRepos('env-1')

    const state = store.getState()
    expect(state.repos.map((repo) => `${repo.executionHostId}:${repo.id}`).sort()).toEqual([
      'local:old',
      `${SERVER}:copied`
    ])
    // The local twin keeps its row and the pre-host row it may own; only the server's row goes.
    expect(state.worktreesByRepo.old?.map((worktree) => worktree.id)).toEqual([
      'old::/local/app',
      'old::/legacy'
    ])
    // Purged like a checkout an authoritative scan lost: its selection and tabs go with it.
    expect(state.activeWorktreeId).toBeNull()
    expect(Object.keys(state.tabsByWorktree)).toEqual(['old::/local/app'])
  })

  it('drops the pre-host rows too once no host registers the repo id', async () => {
    const store = createTestStore()
    seedStore(store, {
      repos: [serverRepo('old')],
      worktreesByRepo: {
        old: [
          makeWorktree({ id: 'old::/srv/app', repoId: 'old', path: '/srv/app', hostId: SERVER }),
          makeWorktree({ id: 'old::/legacy', repoId: 'old', path: '/legacy' })
        ]
      }
    })
    serverRepos = [serverRepo('copied')]

    await store.getState().fetchRuntimeEnvironmentRepos('env-1')

    expect(store.getState().worktreesByRepo.old).toEqual([])
  })
})
