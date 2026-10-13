import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'

const revealFloatingWorkspacePanel = vi.hoisted(() => vi.fn())
vi.mock('./floating-workspace-panel-reveal', () => ({ revealFloatingWorkspacePanel }))

const { revealWorkspaceSurface, selectWorkspaceSurfaceOwner } =
  await import('./workspace-surface-reveal')

function revealState(isNavigatingHistory = false) {
  return {
    settings: { floatingTerminalEnabled: true },
    floatingWorkspacePanelOpen: false,
    updateSettings: vi.fn(async () => {}),
    setActiveView: vi.fn(),
    setActiveWorktree: vi.fn(() => true),
    markWorktreeVisited: vi.fn(),
    recordWorktreeVisit: vi.fn(),
    isNavigatingHistory,
    revealWorktreeInSidebar: vi.fn()
  }
}

beforeEach(() => vi.clearAllMocks())

describe('revealWorkspaceSurface', () => {
  it('opens the floating panel and leaves the main window as it is', () => {
    const state = revealState()

    revealWorkspaceSurface(state, FLOATING_TERMINAL_WORKTREE_ID, { createdTabIds: ['tab-1'] })

    expect(revealFloatingWorkspacePanel).toHaveBeenCalledWith(state)
    expect(state.setActiveView).not.toHaveBeenCalled()
    expect(state.setActiveWorktree).not.toHaveBeenCalled()
    expect(state.markWorktreeVisited).not.toHaveBeenCalled()
    expect(state.recordWorktreeVisit).not.toHaveBeenCalled()
    expect(state.revealWorktreeInSidebar).not.toHaveBeenCalled()
  })

  it.each(['repo::/wt', 'folder:fw-1'])('selects %s in the main window as a visit', (id) => {
    const state = revealState()

    revealWorkspaceSurface(state, id)

    expect(revealFloatingWorkspacePanel).not.toHaveBeenCalled()
    expect(state.setActiveView).toHaveBeenCalledWith('terminal')
    expect(state.setActiveWorktree).toHaveBeenCalledWith(id)
    expect(state.markWorktreeVisited).toHaveBeenCalledWith(id)
    expect(state.recordWorktreeVisit).toHaveBeenCalledWith(id)
    expect(state.revealWorktreeInSidebar).toHaveBeenCalledWith(id)
  })

  it('passes created tabs through and skips the history entry while navigating history', () => {
    const state = revealState(true)

    revealWorkspaceSurface(state, 'repo::/wt', { createdTabIds: ['tab-1'] })

    expect(state.setActiveWorktree).toHaveBeenCalledWith('repo::/wt', undefined, {
      createdTabIds: ['tab-1']
    })
    expect(state.markWorktreeVisited).toHaveBeenCalledWith('repo::/wt')
    expect(state.recordWorktreeVisit).not.toHaveBeenCalled()
  })
})

describe('selectWorkspaceSurfaceOwner', () => {
  it('opens the floating panel instead of selecting the floating workspace', () => {
    const state = revealState()

    selectWorkspaceSurfaceOwner(state, FLOATING_TERMINAL_WORKTREE_ID)

    expect(revealFloatingWorkspacePanel).toHaveBeenCalledWith(state)
    expect(state.setActiveWorktree).not.toHaveBeenCalled()
  })

  it('selects any other workspace without navigating to it', () => {
    const state = revealState()

    selectWorkspaceSurfaceOwner(state, 'repo::/wt')

    expect(state.setActiveWorktree).toHaveBeenCalledWith('repo::/wt')
    expect(state.setActiveView).not.toHaveBeenCalled()
    expect(state.markWorktreeVisited).not.toHaveBeenCalled()
    expect(state.recordWorktreeVisit).not.toHaveBeenCalled()
    expect(state.revealWorktreeInSidebar).not.toHaveBeenCalled()
  })
})
