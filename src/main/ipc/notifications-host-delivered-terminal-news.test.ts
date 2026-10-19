import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getDismissHandler,
  getDispatchHandler,
  resetNotificationDispatchMocks
} from './notifications-test-harness'

vi.mock('electron', async () =>
  (await import('./notifications-test-harness')).createElectronModuleMock()
)

vi.mock('./notification-authorization-status', async () =>
  (await import('./notifications-test-harness')).createNotificationAuthorizationModuleMock()
)

vi.mock('./ui', async () =>
  (await import('./notifications-test-harness')).createTrustedUIRendererModuleMock()
)

vi.mock('../tray/system-tray', async () =>
  (await import('./notifications-test-harness')).createSystemTrayModuleMock()
)

import { registerNotificationHandlers } from './notifications'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
const HOST_ID = 'agent:repo%3A%3Awt1:pane:5000'

function register(hostNews: { notificationId: string | null } | null) {
  const runtime = {
    dispatchMobileNotification: vi.fn(),
    dismissMobileNotification: vi.fn(),
    terminalAgentNewsDeliveredByHost: vi.fn(() => hostNews)
  }
  registerNotificationHandlers(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch and dismiss read only the settings.
    {
      getSettings: () => ({
        notifications: {
          enabled: true,
          agentTaskComplete: true,
          terminalBell: true,
          suppressWhenFocused: false,
          mutedNotificationSourceIds: []
        }
      })
    } as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch and dismiss reach only these members.
    runtime as never
  )
  return runtime
}

const finish = {
  source: 'agent-task-complete',
  worktreeId: 'repo::wt1',
  paneKey: PANE,
  agentState: 'done'
}

describe('the window’s request for news this host already pushed', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-19T16:00:00Z'))
    resetNotificationDispatchMocks()
  })

  it('does not push the phone again, and a read of the pane retires the host’s push', async () => {
    const runtime = register({ notificationId: HOST_ID })
    await getDispatchHandler()({}, finish)
    expect(runtime.terminalAgentNewsDeliveredByHost).toHaveBeenCalledWith(finish)
    expect(runtime.dispatchMobileNotification).not.toHaveBeenCalled()

    await getDismissHandler()({}, [], [PANE])
    expect(runtime.dismissMobileNotification).toHaveBeenCalledWith(HOST_ID)
  })

  it('pushes the phone itself when the host has no such news', async () => {
    const runtime = register(null)
    await getDispatchHandler()({}, finish)
    expect(runtime.dispatchMobileNotification).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete', agentState: 'done' })
    )
  })
})
