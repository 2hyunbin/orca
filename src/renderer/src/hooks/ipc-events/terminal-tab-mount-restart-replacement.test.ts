import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { consumeRestartReplacementForPty, requestBackgroundTerminalWorktreeMount } = vi.hoisted(
  () => ({
    consumeRestartReplacementForPty: vi.fn(),
    requestBackgroundTerminalWorktreeMount: vi.fn()
  })
)

vi.mock('@/components/terminal-pane/pty-connection/restart-replacement-on-show', () => ({
  consumeRestartReplacementForPty
}))
vi.mock('@/components/terminal/background-terminal-worktree-mount', () => ({
  requestBackgroundTerminalWorktreeMount
}))
vi.mock('@/lib/mobile-terminal-tab-mount', () => ({
  planMobileTerminalTabMount: () => ({ worktreeId: 'wt-1', tabIds: ['tab-1'] })
}))
vi.mock('../../store', () => ({ useAppStore: { getState: () => ({}) } }))

import { registerTerminalPresentationIpcBridge } from './terminal-presentation-ipc-bridge'

type TabMountRequest = { worktreeId: string; tabId?: string; ptyId?: string }

function registerTabMountListener(): (request: TabMountRequest) => void {
  let listener: ((request: TabMountRequest) => void) | null = null
  vi.stubGlobal('window', {
    api: {
      ui: {
        onCreateTerminal: () => () => {},
        onRequestTerminalTabMount: (next: (request: TabMountRequest) => void) => {
          listener = next
          return () => {}
        }
      }
    }
  })
  registerTerminalPresentationIpcBridge([])
  if (!listener) {
    throw new Error('expected the tab mount listener')
  }
  return listener
}

describe('a paired client asking the window to mount a terminal tab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("spawns the pane's armed restart replacement instead of mounting", () => {
    consumeRestartReplacementForPty.mockReturnValue(true)

    registerTabMountListener()({ worktreeId: 'wt-1', tabId: 'tab-1', ptyId: 'pty-dead' })

    expect(consumeRestartReplacementForPty).toHaveBeenCalledWith('pty-dead')
    expect(requestBackgroundTerminalWorktreeMount).not.toHaveBeenCalled()
  })

  it('mounts the tab when nothing is armed for the pty', () => {
    consumeRestartReplacementForPty.mockReturnValue(false)

    registerTabMountListener()({ worktreeId: 'wt-1', tabId: 'tab-1', ptyId: 'pty-dead' })

    expect(requestBackgroundTerminalWorktreeMount).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabIds: ['tab-1']
    })
  })
})
