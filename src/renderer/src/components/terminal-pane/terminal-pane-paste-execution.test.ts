// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { createTerminalPanePasteExecution } from './terminal-pane-paste-execution'
import type { TerminalPaneCloseController } from './use-terminal-pane-close-actions'

const mocks = vi.hoisted(() => ({
  pasteTerminalClipboard: vi.fn()
}))

vi.mock('./terminal-clipboard-paste', () => ({
  pasteTerminalClipboard: mocks.pasteTerminalClipboard
}))

const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`

function buildController(): TerminalPaneCloseController {
  return {
    forceBracketedMultilineTextPaste: true,
    managerRef: { current: null },
    paneTransportsRef: { current: new Map() },
    setTerminalError: vi.fn(),
    tabId: TAB_ID,
    worktreeId: 'worktree-1'
  } as unknown as TerminalPaneCloseController
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('createTerminalPanePasteExecution.pasteFromClipboard', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    vi.clearAllMocks()
    mocks.pasteTerminalClipboard.mockResolvedValue({ status: 'pasted', kind: 'text' })
    ;(window as unknown as { api: { ui: Record<string, unknown> } }).api = {
      ui: { saveClipboardImageAsTempFile: vi.fn() }
    }
  })

  afterEach(() => {
    vi.clearAllMocks()
    delete (window as unknown as { api?: unknown }).api
  })

  // Regression for orca#30470: Ctrl+V/Shift+Insert (this path) must carry the
  // same agent-aware Windows newline encoding as right-click paste
  // (terminal-pane-menu-paste.ts), not just the generic bracketed-paste fallback.
  it('passes protectedMultilineTextPasteOptions for a Windows ConPTY agent pane, matching right-click paste', async () => {
    useAppStore.setState({
      agentStatusByPaneKey: {
        [PANE_KEY]: {
          state: 'waiting',
          prompt: '',
          updatedAt: 0,
          stateStartedAt: 0,
          stateHistory: [],
          agentType: 'codex',
          paneKey: PANE_KEY
        }
      },
      paneForegroundAgentByPaneKey: {}
    })

    const pane = { id: 1, leafId: LEAF_ID } as unknown as ManagedPane
    const { pasteFromClipboard } = createTerminalPanePasteExecution(buildController(), 'win32')

    pasteFromClipboard(pane, 'keyboard', vi.fn().mockResolvedValue('line one\nline two'))
    await flush()

    expect(mocks.pasteTerminalClipboard).toHaveBeenCalledOnce()
    const call = mocks.pasteTerminalClipboard.mock.calls[0][0]
    expect(call.protectedMultilineTextPasteOptions).toEqual({
      windowsInputRecordNewline: 'alt-enter'
    })
  })

  it('falls back to the generic bracketed-paste option on a plain shell pane', async () => {
    const pane = { id: 1, leafId: LEAF_ID } as unknown as ManagedPane
    const { pasteFromClipboard } = createTerminalPanePasteExecution(buildController(), 'win32')

    pasteFromClipboard(pane, 'keyboard', vi.fn().mockResolvedValue('line one\nline two'))
    await flush()

    expect(mocks.pasteTerminalClipboard).toHaveBeenCalledOnce()
    const call = mocks.pasteTerminalClipboard.mock.calls[0][0]
    expect(call.protectedMultilineTextPasteOptions).toEqual({
      forceBracketedPasteForMultiline: true
    })
  })
})
