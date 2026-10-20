// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../../../shared/ssh-types'
import { SSH_TARGET_LIST_PAGE_SIZE, SshTargetList } from './SshTargetList'

vi.mock('./SshTargetCard', () => ({
  SshTargetCard: ({ target }: { target: SshTarget }) => <div data-ssh-row>{target.label}</div>
}))

// Why 13,692: the host count from the generated ~/.ssh/config in the crash this guards.
const IMPORTED_HOST_COUNT = 13_692

function configTarget(index: number): SshTarget {
  return {
    id: `ssh-${index}`,
    label: `node-${String(index).padStart(5, '0')}`,
    configHost: `node-${String(index).padStart(5, '0')}`,
    host: `10.0.${Math.floor(index / 256) % 256}.${index % 256}`,
    port: 22,
    username: 'deploy',
    source: 'ssh-config'
  }
}

function renderList(targets: SshTarget[]): void {
  render(
    <SshTargetList
      targets={targets}
      totalBySource={{ 'ssh-config': targets.length, manual: 0 }}
      connectionStates={new Map()}
      testingIds={new Set()}
      busyActionForTarget={() => undefined}
      selection={{
        selected: new Set(),
        click: vi.fn(),
        setGroup: vi.fn(),
        retain: vi.fn(),
        clear: vi.fn()
      }}
      onConnect={vi.fn()}
      onDisconnect={vi.fn()}
      onTest={vi.fn()}
      onEdit={vi.fn()}
      onRemove={vi.fn()}
      onServerChanged={vi.fn()}
    />
  )
}

afterEach(() => {
  cleanup()
})

describe('the SSH host list with a very large imported config', () => {
  it('renders one page of host cards and reveals the next page on request', () => {
    renderList(Array.from({ length: IMPORTED_HOST_COUNT }, (_, index) => configTarget(index)))
    expect(document.querySelectorAll('[data-ssh-row]')).toHaveLength(SSH_TARGET_LIST_PAGE_SIZE)
    expect(screen.queryByText('node-00100')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: `Show ${SSH_TARGET_LIST_PAGE_SIZE} more` }))
    expect(screen.getByText('node-00100')).toBeTruthy()
    expect(screen.queryByText(`node-00${2 * SSH_TARGET_LIST_PAGE_SIZE}`)).toBeNull()
  })

  it('shows every host and no paging control for an ordinary config', () => {
    renderList(Array.from({ length: 3 }, (_, index) => configTarget(index)))
    expect(screen.getByText('node-00002')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /more$/ })).toBeNull()
  })
})
