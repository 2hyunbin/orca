// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ImportedWorktreesVisibilityLine, {
  type ImportedWorktreesVisibilityLineProps
} from './ImportedWorktreesVisibilityLine'
import { TooltipProvider } from '@/components/ui/tooltip'
import { track } from '@/lib/telemetry'
import type { TelemetrySettings } from '../../../../shared/telemetry-settings-types'
import { resetWorkspaceDiscoveryObservationsForTests } from './workspace-discovery-telemetry'

type StoreState = { settings: { telemetry?: TelemetrySettings } | null }
const store = vi.hoisted(() => {
  const state: StoreState = { settings: null }
  return { state }
})
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof store.state) => unknown) => selector(store.state)
}))

function enrollTelemetry(optedIn: boolean): void {
  store.state.settings = {
    telemetry: {
      optedIn,
      installId: 'install',
      existedBeforeTelemetryRelease: false,
      workspaceDiscoveryNewUserCohort: 'treatment'
    }
  }
}

const hiddenWorktrees = [
  { displayName: 'workspace-one', path: '/worktrees/one' },
  { displayName: 'workspace-two', path: '/worktrees/two' }
]

function renderLine(overrides: Partial<ImportedWorktreesVisibilityLineProps> = {}) {
  const onReview = vi.fn()
  const onKeepHidden = vi.fn().mockResolvedValue(true)
  const props = {
    repoDisplayName: 'orca',
    hiddenWorktrees,
    placement: 'repo-group' as const,
    pending: false,
    error: null,
    onReview,
    onKeepHidden,
    ...overrides
  }
  const view = render(
    <TooltipProvider>
      <ImportedWorktreesVisibilityLine {...props} />
    </TooltipProvider>
  )
  return { ...view, onReview, onKeepHidden }
}

beforeEach(() => enrollTelemetry(true))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  resetWorkspaceDiscoveryObservationsForTests()
})

describe('workspace discovery hint', () => {
  it('hands review to the manager without rendering workspace editors in the sidebar', () => {
    const { onReview } = renderLine()
    expect(screen.getByText('2 other workspaces found')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Review hidden workspaces for orca' }))
    expect(onReview).toHaveBeenCalledOnce()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(screen.queryByText('/worktrees/one')).toBeNull()
    expect(vi.mocked(track).mock.calls).toEqual([
      ['workspace_discovery_shown', { surface: 'suggestion', workspace_count: 2 }],
      [
        'workspace_discovery_action',
        { action: 'reviewed', surface: 'suggestion', workspace_count: 2 }
      ]
    ])
  })

  it('dismisses suggestions and recovers focus only after saving succeeds', async () => {
    const onFocusRecovery = vi.fn()
    const { onKeepHidden } = renderLine({ onFocusRecovery })
    fireEvent.click(screen.getByRole('button', { name: 'Hide workspace suggestions for orca' }))
    await waitFor(() => expect(onFocusRecovery).toHaveBeenCalledOnce())
    expect(onKeepHidden).toHaveBeenCalledOnce()
    expect(track).toHaveBeenCalledWith('workspace_discovery_action', {
      action: 'dismissed',
      surface: 'suggestion',
      workspace_count: 2
    })
  })

  it('keeps dismissal retryable and review disabled while a dismissal is in flight', async () => {
    let finish: (value: boolean) => void = () => undefined
    const onKeepHidden = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finish = resolve
          })
      )
      .mockResolvedValue(true)
    const onFocusRecovery = vi.fn()
    renderLine({ onKeepHidden, onFocusRecovery })
    fireEvent.click(screen.getByRole('button', { name: 'Hide workspace suggestions for orca' }))
    expect(
      screen
        .getByRole('button', { name: 'Review hidden workspaces for orca' })
        .hasAttribute('disabled')
    ).toBe(true)
    await act(async () => finish(false))
    expect(screen.getByRole('alert').textContent).toContain('Could not hide suggestions')
    expect(onFocusRecovery).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Hide workspace suggestions for orca' }))
    await waitFor(() => expect(onFocusRecovery).toHaveBeenCalledOnce())
  })

  it('omits empty hints and keeps actions working outside telemetry enrollment', async () => {
    enrollTelemetry(false)
    const { rerender, onReview, onKeepHidden } = renderLine()
    fireEvent.click(screen.getByRole('button', { name: 'Review hidden workspaces for orca' }))
    expect(onReview).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Hide workspace suggestions for orca' }))
    await waitFor(() => expect(onKeepHidden).toHaveBeenCalledOnce())
    expect(track).not.toHaveBeenCalled()
    rerender(
      <ImportedWorktreesVisibilityLine
        repoDisplayName="orca"
        hiddenWorktrees={[]}
        placement="repo-group"
        pending={false}
        error={null}
        onReview={onReview}
      />
    )
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('reports a suggestion once per session across virtual-row remounts', () => {
    renderLine().unmount()
    renderLine()
    expect(vi.mocked(track).mock.calls).toEqual([
      ['workspace_discovery_shown', { surface: 'suggestion', workspace_count: 2 }]
    ])
  })

  it('caps telemetry counts without transmitting workspace or host details', () => {
    renderLine({
      hostContextLabel: 'private-host',
      hiddenWorktrees: Array.from({ length: 100 }, (_, i) => ({
        displayName: `private-${i}`,
        path: `/private/${i}`
      }))
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Review hidden workspaces for orca on private-host' })
    )
    expect(vi.mocked(track).mock.calls).toEqual([
      ['workspace_discovery_shown', { surface: 'suggestion', workspace_count: 50 }],
      [
        'workspace_discovery_action',
        { action: 'reviewed', surface: 'suggestion', workspace_count: 50 }
      ]
    ])
  })
})
