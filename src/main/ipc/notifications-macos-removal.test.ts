import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAttentionOrigin } from '../../shared/agent-session-attention'

import {
  getDismissHandler,
  getDispatchHandler,
  notificationCtorMock,
  notificationRemoveGroupMock,
  notificationRemoveMock,
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
const RELEASE_MS = 5 * 60 * 1000
const originalPlatform = process.platform

const STRUCTURED_ORIGIN: StructuredAttentionOrigin = {
  scope: {
    executionHostId: 'runtime:remote-host',
    wslDistro: null,
    workspaceId: 'remote-folder',
    workspaceKind: 'folder'
  },
  sessionId: 'remote-session',
  cause: { kind: 'prompt', promptId: 'A' },
  journalCursor: { epoch: 'remote-journal', sequence: 1 }
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

function register(): void {
  registerNotificationHandlers(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these paths read only getSettings; Store is a class, so a structural double needs the cast.
    {
      getSettings: () => ({
        notifications: {
          enabled: true,
          agentTaskComplete: true,
          terminalBell: true,
          suppressWhenFocused: false
        }
      })
    } as never
  )
}

function dispatchAgent(notificationId: string): unknown {
  return getDispatchHandler()(
    {},
    { source: 'agent-task-complete', worktreeId: 'repo::wt1', paneKey: PANE, notificationId }
  )
}

function dispatchStructured(): unknown {
  return getDispatchHandler()(
    {},
    {
      source: 'agent-task-complete',
      surface: 'agent-session',
      worktreeId: 'repo::remote',
      paneKey: PANE,
      notificationId: 'agent-attention:A',
      attentionKey: 'agent-attention:A',
      structuredOrigin: STRUCTURED_ORIGIN
    }
  )
}

function lastNotificationOptions(): unknown {
  return notificationCtorMock.mock.lastCall?.[0]
}

describe('macOS Notification Center removal', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-28T16:00:00Z'))
    resetNotificationDispatchMocks()
    setPlatform('darwin')
  })

  afterEach(() => {
    setPlatform(originalPlatform)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('posts an agent notification in its pane thread with no reusable id', async () => {
    register()
    await dispatchAgent('agent:turn-1')

    expect(notificationCtorMock).toHaveBeenCalledOnce()
    expect(lastNotificationOptions()).toMatchObject({ groupId: `pane:${PANE}` })
    expect(lastNotificationOptions()).not.toHaveProperty('id')
  })

  it('posts every bell in its pane thread with no reusable id', async () => {
    register()
    const dispatch = getDispatchHandler()
    await dispatch({}, { source: 'terminal-bell', worktreeId: 'repo::wt1', paneKey: PANE })
    // Past the per-workspace burst cooldown.
    vi.advanceTimersByTime(60_000)
    await dispatch({}, { source: 'terminal-bell', worktreeId: 'repo::wt1', paneKey: PANE })

    expect(notificationCtorMock).toHaveBeenCalledTimes(2)
    for (const [options] of notificationCtorMock.mock.calls) {
      expect(options).toMatchObject({ groupId: `pane:${PANE}` })
      expect(options).not.toHaveProperty('id')
    }
  })

  it('posts a notification with no pane outside any thread', async () => {
    register()
    await getDispatchHandler()({}, { source: 'test' })

    expect(notificationCtorMock).toHaveBeenCalledOnce()
    expect(lastNotificationOptions()).not.toHaveProperty('id')
    expect(lastNotificationOptions()).not.toHaveProperty('groupId')
  })

  it('removes the pane thread after main has released the notification', async () => {
    register()
    await dispatchAgent('agent:turn-1')
    vi.advanceTimersByTime(RELEASE_MS + 1)

    getDismissHandler()({}, ['agent:turn-1'], [PANE])

    expect(notificationRemoveGroupMock).toHaveBeenCalledOnce()
    expect(notificationRemoveGroupMock).toHaveBeenCalledWith(`pane:${PANE}`)
  })

  it('removes an earlier session’s notifications by pane thread after a restart', () => {
    // Nothing was dispatched in this process, so main holds no record of the notification.
    register()

    getDismissHandler()({}, ['agent:rebuilt'], [PANE])

    expect(notificationRemoveGroupMock).toHaveBeenCalledOnce()
    expect(notificationRemoveGroupMock).toHaveBeenCalledWith(`pane:${PANE}`)
  })

  it('keeps a structured alert out of the pane thread until a read covers it', async () => {
    register()
    await dispatchStructured()
    expect(lastNotificationOptions()).toMatchObject({ id: 'agent-attention:A' })
    expect(lastNotificationOptions()).not.toHaveProperty('groupId')
    vi.advanceTimersByTime(RELEASE_MS + 1)

    // A pane read that does not cover the alert clears only the thread it is not in.
    getDismissHandler()({}, [], [PANE])
    expect(notificationRemoveGroupMock).toHaveBeenCalledWith(`pane:${PANE}`)
    expect(notificationRemoveMock).not.toHaveBeenCalled()

    getDismissHandler()(
      {},
      [],
      [PANE],
      [
        {
          paneKey: PANE,
          sessionId: 'remote-session',
          observedCursor: { epoch: 'remote-journal', sequence: 1 }
        }
      ]
    )
    expect(notificationRemoveMock).toHaveBeenCalledWith(['agent-attention:A'])
  })

  it('skips pane threads for missing or malformed pane keys', () => {
    register()

    getDismissHandler()({}, ['agent:turn-1'], ['', 7, null])
    getDismissHandler()({}, ['agent:turn-2'])

    expect(notificationRemoveMock).toHaveBeenCalledTimes(2)
    expect(notificationRemoveGroupMock).not.toHaveBeenCalled()
  })

  it('still clears pane threads and completes the dismissal when Notification Center throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    notificationRemoveMock.mockImplementation(() => {
      throw new Error('unavailable')
    })
    register()
    await dispatchAgent('agent:turn-1')

    expect(getDismissHandler()({}, ['agent:turn-1'], [PANE])).toEqual({ dismissed: 1 })
    expect(notificationRemoveGroupMock).toHaveBeenCalledWith(`pane:${PANE}`)
    expect(warn).toHaveBeenCalledOnce()
  })

  it.each(['win32', 'linux'] as const)('leaves %s on the close() path', async (platform) => {
    setPlatform(platform)
    register()
    await dispatchAgent('agent:turn-1')

    expect(notificationCtorMock).toHaveBeenCalledOnce()
    expect(lastNotificationOptions()).not.toHaveProperty('id')
    expect(lastNotificationOptions()).not.toHaveProperty('groupId')

    getDismissHandler()({}, ['agent:turn-1'], [PANE])
    expect(notificationRemoveMock).not.toHaveBeenCalled()
    expect(notificationRemoveGroupMock).not.toHaveBeenCalled()
  })
})
