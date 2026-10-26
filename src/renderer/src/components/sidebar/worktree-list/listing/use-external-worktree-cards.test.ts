// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { trackWithResult } from '@/lib/telemetry'
import type { AppState } from '@/store/types'
import { getDefaultSettings } from '../../../../../../shared/constants'
import type { TelemetrySettings } from '../../../../../../shared/telemetry-settings-types'
import { makeDetectedWorktree, repo } from '../../worktree-list-groups-test-fixtures'
import { useSidebarExternalWorktreeCards } from './use-external-worktree-cards'
import { buildRows } from '../grouping/build-rows.test-fixture'

type SidebarState = Pick<
  AppState,
  | 'settings'
  | 'updateRepo'
  | 'fetchWorktrees'
  | 'activeModal'
  | 'modalData'
  | 'worktreeVisibilityDefaultsByHost'
  | 'repos'
  | 'detectedWorktreesByRepo'
>
let state: SidebarState

vi.mock('@/lib/telemetry', () => ({ trackWithResult: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: SidebarState) => unknown) => selector(state), {
    getState: () => state
  })
}))

beforeEach(() => {
  vi.mocked(trackWithResult).mockReset().mockResolvedValue(true)
  state = {
    settings: getDefaultSettings('/test'),
    updateRepo: vi.fn().mockResolvedValue(true),
    fetchWorktrees: vi.fn().mockResolvedValue(true),
    activeModal: 'none',
    modalData: {},
    worktreeVisibilityDefaultsByHost: {},
    repos: [],
    detectedWorktreesByRepo: {}
  }
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function assignCohort(cohort: TelemetrySettings['workspaceDiscoveryCohort']): void {
  state.settings = {
    ...getDefaultSettings('/test'),
    telemetry: {
      optedIn: true,
      installId: 'test-install',
      existedBeforeTelemetryRelease: false,
      workspaceDiscoveryCohort: cohort
    }
  }
}

function discoveryArgs() {
  const project = { ...repo, externalWorktreeVisibility: 'hide' as const }
  return {
    repos: [project],
    visibleReposForRows: [project],
    detectedWorktreesByRepo: {
      [project.id]: {
        repoId: project.id,
        authoritative: true,
        source: 'git' as const,
        worktrees: [makeDetectedWorktree()]
      }
    },
    filterRepoIds: []
  }
}

describe('workspace discovery holdout', () => {
  it('retains the project menu when workspace filters leave a control project without visible rows', () => {
    assignCohort('control')
    const args = discoveryArgs()
    const { result } = renderHook(() => useSidebarExternalWorktreeCards(args))
    const cards = result.current
    const rows = buildRows(
      'repo',
      [],
      new Map([[repo.id, args.repos[0]]]),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map(),
      false,
      undefined,
      [],
      cards.discoveryPlaceholderRepoIds,
      cards.importedWorktreesByRepo,
      cards.newExternalWorktreesInboxByRepo
    )
    expect(rows).toMatchObject([{ type: 'header', repo: { id: repo.id } }])
  })
  it.each(['control', 'treatment', undefined] as const)(
    'applies %s to initial and later suggestions while observing eligibility before hiding them',
    async (cohort) => {
      assignCohort(cohort)
      const initialArgs = discoveryArgs()
      const { result, rerender } = renderHook((args) => useSidebarExternalWorktreeCards(args), {
        initialProps: initialArgs
      })
      expect(result.current.importedWorktreesByRepo.has(repo.id)).toBe(cohort !== 'control')
      expect(result.current.newExternalWorktreesInboxByRepo.size).toBe(0)
      await act(async () => {})
      expect(trackWithResult).toHaveBeenCalledTimes(cohort ? 1 : 0)
      if (cohort) {
        expect(trackWithResult).toHaveBeenCalledWith('workspace_discovery_eligible', {})
      }

      const reviewedProject = {
        ...initialArgs.repos[0],
        externalWorktreeVisibilityPromptDismissedAt: 1
      }
      rerender({ ...initialArgs, repos: [reviewedProject], visibleReposForRows: [reviewedProject] })
      expect(result.current.importedWorktreesByRepo.size).toBe(0)
      expect(result.current.newExternalWorktreesInboxByRepo.has(repo.id)).toBe(cohort !== 'control')
      await act(async () => {})
      expect(trackWithResult).toHaveBeenCalledTimes(cohort ? 1 : 0)
    }
  )

  it('keeps control suggestions hidden and leaves management scans to the manager', async () => {
    assignCohort('control')
    state.activeModal = 'worktree-visibility'
    state.modalData = { repoId: repo.id, hostId: 'local' }
    const args = discoveryArgs()
    args.repos[0].externalWorktreeVisibilityPromptDismissedAt = 1
    args.repos[0].externalWorktreeDiscoverySuppressedAt = 1
    const { result } = renderHook(() => useSidebarExternalWorktreeCards(args))
    expect(result.current.importedWorktreeCardActionState.size).toBe(0)
    expect(result.current.importedWorktreesByRepo.size).toBe(0)
    expect(state.fetchWorktrees).not.toHaveBeenCalled()
    expect(trackWithResult).not.toHaveBeenCalled()
  })

  it('dismisses suggestions only on the requested owner when local and remote projects share an ID', async () => {
    assignCohort('control')
    const args = discoveryArgs()
    const remoteRepo = { ...args.repos[0], executionHostId: 'ssh:private-box' as const }
    state.activeModal = 'worktree-visibility'
    state.modalData = { repoId: repo.id, hostId: remoteRepo.executionHostId }
    const remoteArgs = {
      ...args,
      repos: [...args.repos, remoteRepo],
      visibleReposForRows: [...args.repos, remoteRepo],
      detectedWorktreesByRepo: {
        [repo.id]: {
          ...args.detectedWorktreesByRepo[repo.id],
          worktrees: [
            makeDetectedWorktree({ hostId: 'local', path: '/local/hidden' }),
            makeDetectedWorktree({ hostId: remoteRepo.executionHostId, path: '/remote/hidden' })
          ]
        }
      }
    }
    state.repos = remoteArgs.repos
    state.detectedWorktreesByRepo = remoteArgs.detectedWorktreesByRepo
    const { result } = renderHook(() => useSidebarExternalWorktreeCards(remoteArgs))
    await waitFor(() => expect(result.current.importedWorktreeCardActionState.size).toBe(0))
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

  it('waits for an authoritative scan and excludes folder projects', async () => {
    assignCohort('treatment')
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
    expect(trackWithResult).not.toHaveBeenCalled()

    const folderProject = { ...args.repos[0], kind: 'folder' as const }
    rerender({ ...args, repos: [folderProject], visibleReposForRows: [folderProject] })
    expect(result.current.importedWorktreesByRepo.size).toBe(0)
    expect(trackWithResult).not.toHaveBeenCalled()

    rerender(args)
    expect(result.current.importedWorktreesByRepo.has(repo.id)).toBe(true)
    await waitFor(() =>
      expect(trackWithResult).toHaveBeenCalledExactlyOnceWith('workspace_discovery_eligible', {})
    )
  })

  it('does not expose a suggestion before settings hydrate and retains stable empty maps in control', async () => {
    const args = discoveryArgs()
    state.settings = null
    const { result, rerender } = renderHook(() => useSidebarExternalWorktreeCards(args))
    expect(result.current.importedWorktreesByRepo.size).toBe(0)
    expect(result.current.newExternalWorktreesInboxByRepo.size).toBe(0)
    const hiddenImported = result.current.importedWorktreesByRepo
    const hiddenInbox = result.current.newExternalWorktreesInboxByRepo

    assignCohort('control')
    rerender()
    await waitFor(() => expect(trackWithResult).toHaveBeenCalledTimes(1))
    expect(result.current.importedWorktreesByRepo).toBe(hiddenImported)
    expect(result.current.newExternalWorktreesInboxByRepo).toBe(hiddenInbox)
    expect(state.fetchWorktrees).not.toHaveBeenCalled()
    expect(state.updateRepo).not.toHaveBeenCalled()
  })

  it('retries a rejected observation after consent changes without changing the experience', async () => {
    assignCohort('treatment')
    const args = discoveryArgs()
    vi.mocked(trackWithResult).mockResolvedValueOnce(false)
    const { result, rerender } = renderHook(() => useSidebarExternalWorktreeCards(args))
    await act(async () => {})
    expect(trackWithResult).toHaveBeenCalledTimes(1)

    state.settings = {
      ...getDefaultSettings('/test'),
      telemetry: {
        optedIn: false,
        installId: 'test-install',
        existedBeforeTelemetryRelease: false,
        workspaceDiscoveryCohort: 'treatment'
      }
    }
    rerender()
    expect(result.current.importedWorktreesByRepo.has(repo.id)).toBe(true)
    expect(trackWithResult).toHaveBeenCalledTimes(1)
    assignCohort('treatment')
    rerender()
    await waitFor(() => expect(trackWithResult).toHaveBeenCalledTimes(2))
  })

  it('serializes pending observations and retries after an in-flight rejection and settings change', async () => {
    assignCohort('treatment')
    let settle: (accepted: boolean) => void = () => undefined
    vi.mocked(trackWithResult).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve
        })
    )
    const args = discoveryArgs()
    const { rerender } = renderHook(() => useSidebarExternalWorktreeCards(args))
    await waitFor(() => expect(trackWithResult).toHaveBeenCalledTimes(1))
    assignCohort('treatment')
    rerender()
    expect(trackWithResult).toHaveBeenCalledTimes(1)
    await act(async () => settle(false))
    await waitFor(() => expect(trackWithResult).toHaveBeenCalledTimes(2))
  })
})
