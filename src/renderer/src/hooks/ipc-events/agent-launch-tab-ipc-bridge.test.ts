import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StartupDraftNotPastedEvent } from '../../../../shared/startup-draft-not-pasted'

const notice = vi.hoisted(() => ({ create: vi.fn(), onTimeout: vi.fn() }))
vi.mock('@/lib/launch-agent-paste-timeout-notice', () => ({
  createPasteReadinessTimeoutNotice: (args: unknown) => {
    notice.create(args)
    return { onTimeout: notice.onTimeout, wasNotified: () => false }
  }
}))
vi.mock('@/lib/agent-launch-tab-publication', () => ({ publishAgentLaunchTab: vi.fn() }))
vi.mock('@/lib/agent-launch-pane-verdict-application', () => ({
  applyAgentLaunchPaneVerdict: vi.fn()
}))
vi.mock('@/lib/agent-launch-tab-main-written', () => ({ keepAgentLaunchTabMainWrote: vi.fn() }))
vi.mock('@/runtime/layout-frame-position', () => ({ afterLayoutFrame: vi.fn() }))

describe('agent launch tab IPC bridge', () => {
  afterEach(() => vi.unstubAllGlobals())

  it("shows the window's own not-sent notice when main's draft paste for its tab never lands", async () => {
    const listener: { current: ((event: StartupDraftNotPastedEvent) => void) | null } = {
      current: null
    }
    vi.stubGlobal('window', {
      api: {
        ui: {
          onPublishAgentLaunchTab: () => () => {},
          onAgentLaunchPaneVerdict: () => () => {},
          onStartupDraftNotPasted: (callback: (event: StartupDraftNotPastedEvent) => void) => {
            listener.current = callback
            return () => {}
          }
        }
      }
    })
    const { registerAgentLaunchTabIpcBridge } = await import('./agent-launch-tab-ipc-bridge')

    registerAgentLaunchTabIpcBridge([])
    listener.current?.({ worktreeId: 'wt-1', tabId: 'tab-1', agent: 'codex' })

    expect(notice.create).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      agent: 'codex',
      submitted: false
    })
    expect(notice.onTimeout).toHaveBeenCalledOnce()
  })
})
