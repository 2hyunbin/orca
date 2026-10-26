// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ImportedWorktreesVisibilityLine, {
  type ImportedWorktreesVisibilityLineProps
} from './ImportedWorktreesVisibilityLine'
import { TooltipProvider } from '@/components/ui/tooltip'

const hiddenWorktrees = [
  { displayName: 'openusage', path: '/worktrees/one', branch: 'refs/heads/feature-one' },
  { displayName: 'openusage', path: '/worktrees/two', branch: 'refs/heads/feature-two' }
]
function renderLine(overrides: Partial<ImportedWorktreesVisibilityLineProps> = {}) {
  const onShow = vi.fn().mockResolvedValue(true)
  const onKeepHidden = vi.fn().mockResolvedValue(true)
  const props = {
    repoDisplayName: 'orca',
    hiddenWorktrees,
    placement: 'repo-group' as const,
    pending: false,
    error: null,
    onShow,
    onKeepHidden,
    ...overrides
  }
  const view = render(
    <TooltipProvider>
      <ImportedWorktreesVisibilityLine {...props} />
    </TooltipProvider>
  )
  return { ...view, onShow, onKeepHidden }
}
afterEach(cleanup)

describe('workspace discovery', () => {
  it('starts collapsed and adds only the selected path, with names and paths visible', async () => {
    const { onShow } = renderLine()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Review hidden workspaces for orca' }))
    expect(screen.getByText('/worktrees/two')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('checkbox')[1])
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 to sidebar' }))
    await waitFor(() => expect(onShow).toHaveBeenCalledWith(['/worktrees/two']))
    await waitFor(() => expect(screen.queryAllByRole('checkbox')).toHaveLength(0))
  })

  it('retains selection when adding fails and retries it', async () => {
    const onShow = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    renderLine({ onShow })
    fireEvent.click(screen.getByRole('button', { name: 'Review hidden workspaces for orca' }))
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 to sidebar' }))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Add 1 to sidebar' }).hasAttribute('disabled')
      ).toBe(false)
    )
    expect(screen.getAllByRole('checkbox')[0].getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 to sidebar' }))
    await waitFor(() => expect(onShow).toHaveBeenCalledTimes(2))
    expect(onShow).toHaveBeenLastCalledWith(['/worktrees/one'])
  })

  it('locks dismissal and selection while saving', async () => {
    let finish: (value: boolean) => void = () => undefined
    const onShow = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        })
    )
    renderLine({ onShow })
    fireEvent.click(screen.getByRole('button', { name: 'Review hidden workspaces for orca' }))
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 to sidebar' }))
    expect(
      screen
        .getByRole('button', { name: 'Hide workspace suggestions for orca' })
        .hasAttribute('disabled')
    ).toBe(true)
    expect(screen.getAllByRole('checkbox')[0].hasAttribute('disabled')).toBe(true)
    await act(async () => finish(true))
  })

  it('preserves checked workspaces through search', async () => {
    const worktrees = Array.from({ length: 25 }, (_, i) => ({
      displayName: `workspace-${i}`,
      path: `/worktrees/${i}`
    }))
    const onShow = vi.fn().mockResolvedValue(true)
    renderLine({ hiddenWorktrees: worktrees, onShow })
    fireEvent.click(screen.getByRole('button', { name: 'Review hidden workspaces for orca' }))
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'workspace-24' } })
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 to sidebar' }))
    await waitFor(() => expect(onShow).toHaveBeenCalledWith(['/worktrees/0', '/worktrees/24']))
  })

  it('opens management without another dismiss action and closes it with Escape', () => {
    const onClose = vi.fn()
    renderLine({ managing: true, onClose })
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Hide workspace suggestions for orca' })).toBeNull()
    fireEvent.keyDown(screen.getAllByRole('checkbox')[0], { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('dismisses suggestions directly without a confirmation or secondary button', async () => {
    const { onKeepHidden } = renderLine()
    fireEvent.click(screen.getByRole('button', { name: 'Hide workspace suggestions for orca' }))
    await waitFor(() => expect(onKeepHidden).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('Keep hidden')).toBeNull()
  })
})
