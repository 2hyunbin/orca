// @vitest-environment happy-dom
import type { PropsWithChildren } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { RuntimeEnvironmentStatus } from '../../../../shared/runtime-host-status'
import type { SshConnectionState, SshConnectionStatus } from '../../../../shared/ssh-types'
import type { Repo } from '../../../../shared/repo-types'
import { SshStatusSegment } from './SshStatusSegment'
import { SSH_STATUS_MENU_IDLE_ROW_LIMIT } from './ssh-status-menu-rows'

function noSettings(): GlobalSettings | null {
  return null
}

const state = {
  sshTargetLabels: new Map<string, string>(),
  sshConnectionStates: new Map<string, SshConnectionState>(),
  repos: new Array<Pick<Repo, 'id' | 'connectionId'>>(),
  runtimeEnvironments: new Array<PublicKnownRuntimeEnvironment>(),
  runtimeStatusByEnvironmentId: new Map<string, RuntimeEnvironmentStatus>(),
  settings: noSettings(),
  readRuntimeHostStatusSnapshots: vi.fn(async () => undefined),
  hydrateRuntimeEnvironmentStatuses: vi.fn(),
  recordFeatureInteraction: vi.fn(),
  openSettingsTarget: vi.fn(),
  setActiveView: vi.fn()
}

vi.mock('../../store', () => {
  const useAppStore = (selector: (value: typeof state) => unknown) => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})
vi.mock('../../lib/ssh-config-passive-sync', () => ({
  syncSshConfigTargetsPassively: vi.fn(async () => undefined)
}))
vi.mock('@/components/ui/dropdown-menu', () => {
  const content = ({ children }: PropsWithChildren) => <div>{children}</div>
  return {
    DropdownMenu: content,
    DropdownMenuContent: content,
    DropdownMenuItem: ({ children, onSelect }: PropsWithChildren<{ onSelect?: () => void }>) => (
      <div role="menuitem" onClick={onSelect}>
        {children}
      </div>
    ),
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuTrigger: content,
    DropdownMenuSub: content,
    DropdownMenuSubContent: content,
    DropdownMenuSubTrigger: content
  }
})

// Why 13,692: the host count from the generated ~/.ssh/config in the crash this guards.
const IMPORTED_HOST_COUNT = 13_692

function connectionState(targetId: string, status: SshConnectionStatus): SshConnectionState {
  return { targetId, status, error: null, reconnectAttempt: 0 }
}

beforeEach(() => {
  vi.clearAllMocks()
  state.sshTargetLabels = new Map(
    Array.from({ length: IMPORTED_HOST_COUNT }, (_, index) => [
      `ssh-${index}`,
      `node-${String(index).padStart(5, '0')}`
    ])
  )
  state.sshConnectionStates = new Map([
    ['ssh-9000', connectionState('ssh-9000', 'connected')],
    ['ssh-13000', connectionState('ssh-13000', 'reconnecting')]
  ])
  state.repos = [{ id: 'repo-1', connectionId: 'ssh-12345' }]
})

afterEach(() => {
  cleanup()
})

describe('the status menu with a very large imported SSH host list', () => {
  it('renders a bounded number of idle host rows instead of one per imported host', () => {
    render(<SshStatusSegment compact={false} iconOnly={false} />)
    const connectButtons = screen.queryAllByRole('button', { name: 'Connect' })
    expect(connectButtons.length).toBeLessThanOrEqual(SSH_STATUS_MENU_IDLE_ROW_LIMIT + 1)
    expect(document.body.getElementsByTagName('*').length).toBeLessThan(2_000)
  })

  it('always lists connected and in-progress hosts, wherever they sit in the list', () => {
    render(<SshStatusSegment compact={false} iconOnly={false} />)
    expect(screen.getByText('node-09000')).toBeTruthy()
    expect(screen.getByText('node-13000')).toBeTruthy()
    expect(screen.getByText('node-00000')).toBeTruthy()
    expect(screen.queryByText('node-13691')).toBeNull()
  })

  it('keeps an idle host that owns a project, even deep in the config', () => {
    render(<SshStatusSegment compact={false} iconOnly={false} />)
    expect(screen.getByText('node-12345')).toBeTruthy()
  })

  it('says how many idle hosts are hidden and finds any of them by name', () => {
    render(<SshStatusSegment compact={false} iconOnly={false} />)
    const hidden = IMPORTED_HOST_COUNT - 2 - SSH_STATUS_MENU_IDLE_ROW_LIMIT
    expect(screen.getByText(`${hidden} more SSH hosts. Search by name to find one.`)).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search SSH hosts…' }), {
      target: { value: 'NODE-13691' }
    })
    expect(screen.getByText('node-13691')).toBeTruthy()
    expect(screen.queryByText('node-00000')).toBeNull()
    // Live and busy hosts stay listed while searching.
    expect(screen.getByText('node-09000')).toBeTruthy()
    expect(screen.queryByText(/more SSH hosts/)).toBeNull()
  })

  it('says when no idle host matches the search', () => {
    render(<SshStatusSegment compact={false} iconOnly={false} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Search SSH hosts…' }), {
      target: { value: 'no-such-host' }
    })
    expect(screen.getByText('No SSH hosts match.')).toBeTruthy()
    expect(screen.queryAllByRole('button', { name: 'Connect' })).toHaveLength(0)
  })

  it('shows no search box when every idle host fits', () => {
    state.sshTargetLabels = new Map([['ssh-1', 'solo']])
    state.sshConnectionStates = new Map()
    render(<SshStatusSegment compact={false} iconOnly={false} />)
    expect(screen.getByText('solo')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})
