// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { getDefaultSettings } from '../../../../shared/constants'
import { makeDetectedWorktree, repo } from './worktree-list-groups-test-fixtures'
import WorktreeVisibilityDialog from './WorktreeVisibilityDialog'
import { TooltipProvider } from '@/components/ui/tooltip'

type ManagerState = Pick<
  AppState,
  | 'activeModal'
  | 'modalData'
  | 'closeModal'
  | 'repos'
  | 'settings'
  | 'worktreeVisibilityDefaultsByHost'
  | 'detectedWorktreesByRepo'
  | 'updateRepo'
  | 'fetchWorktrees'
  | 'openSettingsTarget'
  | 'openSettingsPage'
>
let state: ManagerState
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: ManagerState) => unknown) => selector(state), {
    getState: () => state
  })
}))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 56,
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, 10) }, (_, index) => ({ index, start: index * 56 })),
    measureElement: vi.fn()
  })
}))

beforeEach(() => {
  state = {
    activeModal: 'worktree-visibility',
    modalData: { repoId: repo.id, hostId: 'local' },
    closeModal: vi.fn(),
    openSettingsTarget: vi.fn(),
    openSettingsPage: vi.fn(),
    repos: [{ ...repo, externalWorktreeVisibility: 'hide' }],
    settings: getDefaultSettings('/tmp'),
    worktreeVisibilityDefaultsByHost: {},
    detectedWorktreesByRepo: {
      [repo.id]: {
        repoId: repo.id,
        authoritative: true,
        source: 'git',
        worktrees: [makeDetectedWorktree()]
      }
    },
    updateRepo: vi.fn().mockResolvedValue(true),
    fetchWorktrees: vi.fn().mockResolvedValue(true)
  }
})
afterEach(cleanup)

function renderManager() {
  return render(
    <TooltipProvider>
      <WorktreeVisibilityDialog />
    </TooltipProvider>
  )
}

describe('workspace management selection', () => {
  it('links directly from visibility settings to global source defaults', () => {
    renderManager()
    fireEvent.click(screen.getByRole('button', { name: 'Visibility settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Manage in Global Settings' }))
    expect(state.closeModal).toHaveBeenCalledOnce()
    expect(state.openSettingsTarget).toHaveBeenCalledWith({
      pane: 'general',
      repoId: null,
      sectionId: 'general-global-worktree-visibility'
    })
    expect(state.openSettingsPage).toHaveBeenCalledOnce()
  })

  it('keeps source controls reachable under the secondary visibility settings section', async () => {
    renderManager()
    expect(screen.queryByRole('button', { name: 'Manage in Global Settings' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Visibility settings' }))
    expect(screen.getByRole('button', { name: 'Manage in Global Settings' })).toBeTruthy()
  })

  it('preserves selection through search and retries a failed batch without changing source visibility', async () => {
    const paths = Array.from({ length: 25 }, (_, i) => `/tmp/workspace-${i}`)
    state.detectedWorktreesByRepo = {
      [repo.id]: {
        repoId: repo.id,
        authoritative: true,
        source: 'git',
        worktrees: paths.map((path, i) =>
          makeDetectedWorktree({ path, displayName: `workspace-${i}` })
        )
      }
    }
    const view = renderManager()
    await waitFor(() =>
      expect(
        screen.getByRole('checkbox', { name: /workspace-0 at/ }).hasAttribute('disabled')
      ).toBe(false)
    )
    fireEvent.click(screen.getByRole('checkbox', { name: /workspace-0 at/ }))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'workspace-24' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /workspace-24 at/ }))
    vi.mocked(state.updateRepo).mockResolvedValueOnce(false)
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 to sidebar' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(
      screen.getByRole('checkbox', { name: /workspace-24 at/ }).getAttribute('aria-checked')
    ).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 to sidebar' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(state.updateRepo).toHaveBeenLastCalledWith(
      repo.id,
      {
        importedExternalWorktreePaths: [paths[0], paths[24]],
        externalWorktreeInboxBaselinePaths: [paths[0], paths[24]]
      },
      { hostId: 'local' }
    )
    expect(screen.getByRole('button', { name: 'Add to sidebar' }).hasAttribute('disabled')).toBe(
      true
    )
    state.detectedWorktreesByRepo = {
      [repo.id]: {
        repoId: repo.id,
        authoritative: true,
        source: 'git',
        worktrees: paths
          .slice(1, 10)
          .map((path) => makeDetectedWorktree({ path, displayName: path }))
      }
    }
    view.rerender(
      <TooltipProvider>
        <WorktreeVisibilityDialog />
      </TooltipProvider>
    )
    expect(screen.getByRole('searchbox')).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
    expect(screen.getAllByRole('checkbox')).toHaveLength(9)
  })

  it('clears selection on project changes and ignores an earlier scan result', async () => {
    const view = renderManager()
    const select = screen.getByRole('checkbox')
    await waitFor(() => expect(select.hasAttribute('disabled')).toBe(false))
    fireEvent.click(select)
    let finishScan: (value: boolean) => void = () => undefined
    vi.mocked(state.fetchWorktrees).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishScan = resolve
        })
    )
    const second = { ...repo, id: 'repo-2', externalWorktreeVisibility: 'hide' as const }
    state.repos = [...state.repos, second]
    state.modalData = { repoId: second.id, hostId: 'local' }
    state.detectedWorktreesByRepo = {
      ...state.detectedWorktreesByRepo,
      [second.id]: {
        repoId: second.id,
        authoritative: true,
        source: 'git',
        worktrees: [makeDetectedWorktree({ repoId: second.id, path: '/tmp/second-hidden' })]
      }
    }
    view.rerender(
      <TooltipProvider>
        <WorktreeVisibilityDialog />
      </TooltipProvider>
    )
    expect(screen.getByRole('button', { name: 'Add to sidebar' }).hasAttribute('disabled')).toBe(
      true
    )
    state.modalData = { repoId: repo.id, hostId: 'local' }
    view.rerender(
      <TooltipProvider>
        <WorktreeVisibilityDialog />
      </TooltipProvider>
    )
    await act(async () => finishScan(false))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('button', { name: /Show hidden at/ }).hasAttribute('disabled')).toBe(
      false
    )
  })
})
