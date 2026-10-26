// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ResourceGitMaintenanceStatus } from './ResourceGitMaintenanceStatus'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

afterEach(cleanup)

it('shows local and remote activity with host context, then disappears when both finish', () => {
  const view = render(
    <ResourceGitMaintenanceStatus
      local={[{ repoPath: 'C:\\projects\\orca', phase: 'objects' }]}
      hosts={[
        {
          hostId: 'runtime:build',
          hostLabel: 'Build host',
          worktrees: [],
          gitMaintenance: [{ repoPath: '/srv/orca', phase: 'pack-index' }]
        },
        { hostId: 'runtime:old', hostLabel: 'Old host', worktrees: [] }
      ]}
    />
  )
  expect(screen.getByRole('status').textContent).toContain('Git maintenance running')
  expect(screen.getByText('This computer')).toBeTruthy()
  expect(screen.getByText('Build host')).toBeTruthy()
  expect(screen.getAllByText('orca')).toHaveLength(2)
  expect(screen.getByText('Compacting objects')).toBeTruthy()
  expect(screen.getByText('Updating pack index')).toBeTruthy()
  expect(screen.queryByText('Old host')).toBeNull()

  view.rerender(<ResourceGitMaintenanceStatus local={[]} hosts={[]} />)
  expect(screen.queryByRole('status')).toBeNull()
})

it('renders nothing for snapshots from hosts without maintenance reporting', () => {
  render(
    <ResourceGitMaintenanceStatus
      local={undefined}
      hosts={[{ hostId: 'runtime:old', hostLabel: 'Old host', worktrees: [] }]}
    />
  )
  expect(screen.queryByRole('status')).toBeNull()
})
