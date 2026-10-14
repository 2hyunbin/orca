// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useAppStore } from '@/store'
import { makeFolderWorkspace, makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { ManagedWorkspacePicker } from './ManagedWorkspacePicker'

const activation = vi.hoisted(() =>
  vi.fn<() => { primaryTabId: null } | false>(() => ({ primaryTabId: null }))
)
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorkspace: activation }))
const initial = useAppStore.getInitialState()
beforeEach(() => {
  activation.mockReset().mockReturnValue({ primaryTabId: null })
  useAppStore.setState({
    modalData: { managedWorkspaceEnvironmentId: 'child' },
    projectGroups: [],
    worktreesByRepo: {
      local: [
        makeWorktree({ id: 'same', repoId: 'local', displayName: 'Local task', hostId: 'local' })
      ],
      child: [
        makeWorktree({
          id: 'same',
          repoId: 'child',
          displayName: 'Child task',
          hostId: 'runtime:child'
        }),
        makeWorktree({
          id: 'archived',
          repoId: 'child',
          displayName: 'Archived task',
          hostId: 'runtime:child',
          isArchived: true
        })
      ]
    },
    folderWorkspaces: [
      makeFolderWorkspace({ id: 'same-folder', name: 'Local folder', executionHostId: 'local' }),
      makeFolderWorkspace({
        id: 'same-folder',
        name: 'Child folder',
        executionHostId: 'runtime:child'
      }),
      makeFolderWorkspace({
        id: 'foreign-folder',
        name: 'Other machine',
        executionHostId: 'runtime:other'
      })
    ]
  })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})

it('shows only non-archived workspaces on the selected child, including colliding folder and Git IDs', () => {
  render(<ManagedWorkspacePicker environmentId="child" onOpen={vi.fn()} />)
  expect(screen.getByRole('region', { name: 'Saved workspaces' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Open Child task' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Open Child folder' })).toBeTruthy()
  expect(screen.queryByText('Local task')).toBeNull()
  expect(screen.queryByText('Local folder')).toBeNull()
  expect(screen.queryByText('Other machine')).toBeNull()
  expect(screen.queryByText('Archived task')).toBeNull()
})

it.each([
  { name: 'Child task', id: 'same' },
  { name: 'Child folder', id: 'folder:same-folder' }
])('activates $name through the normal host-qualified path before closing', ({ name, id }) => {
  const close = vi.fn()
  render(<ManagedWorkspacePicker environmentId="child" onOpen={close} />)
  fireEvent.click(screen.getByRole('button', { name: `Open ${name}` }))
  expect(activation).toHaveBeenCalledExactlyOnceWith(id, {
    executionHostId: 'runtime:child',
    showWorkspaceList: true
  })
  expect(close).toHaveBeenCalledOnce()
})

it('leaves the dialog open when normal activation refuses a missing or unavailable workspace', () => {
  activation.mockReturnValue(false)
  const close = vi.fn()
  render(<ManagedWorkspacePicker environmentId="child" onOpen={close} />)
  fireEvent.click(screen.getByRole('button', { name: 'Open Child task' }))
  expect(close).not.toHaveBeenCalled()
})

it('rejects a stale click after the requested machine changes', () => {
  const close = vi.fn()
  render(<ManagedWorkspacePicker environmentId="child" onOpen={close} />)
  useAppStore.setState({ modalData: { managedWorkspaceEnvironmentId: 'other' } })
  fireEvent.click(screen.getByRole('button', { name: 'Open Child folder' }))
  expect(activation).not.toHaveBeenCalled()
  expect(close).not.toHaveBeenCalled()
})

it('leaves a machine with no saved workspaces to the existing project flow', () => {
  const view = render(<ManagedWorkspacePicker environmentId="empty" onOpen={vi.fn()} />)
  expect(view.container.textContent).toBe('')
})
