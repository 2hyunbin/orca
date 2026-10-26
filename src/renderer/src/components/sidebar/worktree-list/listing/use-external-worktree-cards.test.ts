// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { getRepoHostIdentity } from '@/store/slices/repo-host-identity'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { makeDetectedWorktree, repo } from '../../worktree-list-groups-test-fixtures'
import { useSidebarExternalWorktreeCards } from './use-external-worktree-cards'

type SidebarState = Pick<
  AppState,
  | 'settings'
  | 'updateRepo'
  | 'fetchWorktrees'
  | 'worktreeVisibilityDefaultsByHost'
  | 'repos'
  | 'detectedWorktreesByRepo'
>
let state: SidebarState

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: SidebarState) => unknown) => selector(state), {
    getState: () => state
  })
}))

beforeEach(() => {
  state = {
    settings: getDefaultSettings('/test'),
    updateRepo: vi.fn().mockResolvedValue(true),
    fetchWorktrees: vi.fn().mockResolvedValue(true),
    worktreeVisibilityDefaultsByHost: {},
    repos: [],
    detectedWorktreesByRepo: {}
  }
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function discoveryArgs(authoritative = true) {
  const project = { ...repo, externalWorktreeVisibility: 'hide' as const }
  const detectedWorktreesByRepo = {
    [project.id]: {
      repoId: project.id,
      authoritative,
      source: 'git' as const,
      worktrees: [makeDetectedWorktree()]
    }
  }
  state.repos = [project]
  state.detectedWorktreesByRepo = detectedWorktreesByRepo
  return {
    repos: [project],
    visibleReposForRows: [project],
    detectedWorktreesByRepo,
    filterRepoIds: []
  }
}

describe('workspace discovery suggestions', () => {
  it('waits for an authoritative scan and excludes folder projects', () => {
    const args = discoveryArgs()
    const { result, rerender } = renderHook((input) => useSidebarExternalWorktreeCards(input), {
      initialProps: {
        ...args,
        detectedWorktreesByRepo: {
          [repo.id]: { ...args.detectedWorktreesByRepo[repo.id], authoritative: false }
        }
      }
    })
    expect(result.current.importedWorktreesByRepo.size).toBe(0)

    const folderProject = { ...args.repos[0], kind: 'folder' as const }
    rerender({ ...args, repos: [folderProject], visibleReposForRows: [folderProject] })
    expect(result.current.importedWorktreesByRepo.size).toBe(0)

    rerender(args)
    expect(result.current.importedWorktreesByRepo.has(repo.id)).toBe(true)
  })

  it('moves a reviewed project from the first suggestion to the new-workspace inbox', () => {
    const args = discoveryArgs()
    const reviewed = { ...args.repos[0], externalWorktreeVisibilityPromptDismissedAt: 1 }
    const { result } = renderHook(() =>
      useSidebarExternalWorktreeCards({
        ...args,
        repos: [reviewed],
        visibleReposForRows: [reviewed]
      })
    )
    expect(result.current.importedWorktreesByRepo.size).toBe(0)
    expect(result.current.newExternalWorktreesInboxByRepo.has(repo.id)).toBe(true)
  })

  it('dismisses from an authoritative snapshot without rescanning', async () => {
    const args = discoveryArgs()
    const { result } = renderHook(() => useSidebarExternalWorktreeCards(args))
    await act(async () => {
      expect(await result.current.handleKeepImportedWorktreesHidden(args.repos[0])).toBe(true)
    })
    expect(state.fetchWorktrees).not.toHaveBeenCalled()
    expect(state.updateRepo).toHaveBeenCalledExactlyOnceWith(
      repo.id,
      {
        externalWorktreeVisibilityPromptDismissedAt: expect.any(Number),
        externalWorktreeDiscoverySuppressedAt: expect.any(Number),
        externalWorktreeInboxBaselinePaths: ['/tmp/hidden']
      },
      { hostId: 'local' }
    )
  })

  it('rescans a stale snapshot before dismissing and reports a failed scan', async () => {
    const args = discoveryArgs(false)
    vi.mocked(state.fetchWorktrees).mockResolvedValueOnce(false)
    const { result } = renderHook(() => useSidebarExternalWorktreeCards(args))
    await act(async () => {
      expect(await result.current.handleKeepImportedWorktreesHidden(args.repos[0])).toBe(false)
    })
    expect(state.fetchWorktrees).toHaveBeenCalledWith(repo.id, {
      requireAuthoritative: true,
      executionHostId: 'local'
    })
    expect(state.updateRepo).not.toHaveBeenCalled()
    expect(
      result.current.importedWorktreeCardActionState.get(getRepoHostIdentity(args.repos[0]))?.error
    ).toBe('Could not save workspace visibility. Try again.')
  })

  it('dismisses suggestions only on the requested owner when local and remote projects share an ID', async () => {
    const args = discoveryArgs()
    const remoteRepo = { ...args.repos[0], executionHostId: 'ssh:private-box' as const }
    const detectedWorktreesByRepo = {
      [repo.id]: {
        ...args.detectedWorktreesByRepo[repo.id],
        worktrees: [
          makeDetectedWorktree({ hostId: 'local', path: '/local/hidden' }),
          makeDetectedWorktree({ hostId: remoteRepo.executionHostId, path: '/remote/hidden' })
        ]
      }
    }
    state.repos = [...args.repos, remoteRepo]
    state.detectedWorktreesByRepo = detectedWorktreesByRepo
    const { result } = renderHook(() =>
      useSidebarExternalWorktreeCards({
        ...args,
        repos: state.repos,
        visibleReposForRows: state.repos,
        detectedWorktreesByRepo
      })
    )
    await act(async () => {
      expect(await result.current.handleKeepImportedWorktreesHidden(remoteRepo)).toBe(true)
    })
    expect(state.updateRepo).toHaveBeenCalledExactlyOnceWith(
      repo.id,
      {
        externalWorktreeVisibilityPromptDismissedAt: expect.any(Number),
        externalWorktreeDiscoverySuppressedAt: expect.any(Number),
        externalWorktreeInboxBaselinePaths: ['/remote/hidden']
      },
      { hostId: remoteRepo.executionHostId }
    )
  })

  it('keeps a remote inbox when a same-ID local project shows its first suggestion', () => {
    const local = { ...repo, externalWorktreeVisibility: 'hide' as const }
    const remote = {
      ...local,
      executionHostId: 'ssh:private-box' as const,
      externalWorktreeVisibilityPromptDismissedAt: 1
    }
    const detectedWorktreesByRepo = {
      [repo.id]: {
        repoId: repo.id,
        authoritative: true,
        source: 'git' as const,
        worktrees: [
          makeDetectedWorktree({ hostId: 'local', path: '/local/hidden' }),
          makeDetectedWorktree({ hostId: remote.executionHostId, path: '/remote/new' })
        ]
      }
    }
    state.repos = [remote, local]
    state.detectedWorktreesByRepo = detectedWorktreesByRepo
    const { result } = renderHook(() =>
      useSidebarExternalWorktreeCards({
        repos: state.repos,
        visibleReposForRows: state.repos,
        detectedWorktreesByRepo,
        filterRepoIds: []
      })
    )
    expect(result.current.importedWorktreesByRepo.get(repo.id)?.repo).toBe(local)
    expect(result.current.newExternalWorktreesInboxByRepo.get(repo.id)?.repo).toBe(remote)
  })
})
