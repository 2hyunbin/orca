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

function createExecution(): ReturnType<typeof createTerminalPanePasteExecution> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: paste execution reads only these controller fields.
  const controller = {
    forceBracketedMultilineTextPaste: true,
    managerRef: { current: null },
    paneTransportsRef: { current: new Map() },
    setTerminalError: vi.fn(),
    tabId: TAB_ID,
    worktreeId: 'worktree-1'
  } as unknown as TerminalPaneCloseController
  return createTerminalPanePasteExecution(controller, 'win32')
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: option resolution reads only the pane ids.
const pane = { id: 1, leafId: LEAF_ID } as unknown as ManagedPane

async function pasteWithKeyboard(): Promise<unknown> {
  createExecution().pasteFromClipboard(pane, 'keyboard', vi.fn())
  await vi.waitFor(() => expect(mocks.pasteTerminalClipboard).toHaveBeenCalledOnce())
  return mocks.pasteTerminalClipboard.mock.calls[0][0].protectedMultilineTextPasteOptions
}

describe('createTerminalPanePasteExecution.pasteFromClipboard', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    mocks.pasteTerminalClipboard.mockReset().mockResolvedValue({ status: 'pasted', kind: 'text' })
    vi.stubGlobal('api', { ui: { saveClipboardImageAsTempFile: vi.fn() } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends Windows Codex newlines as Alt+Enter on Ctrl+V, like right-click paste', async () => {
    useAppStore.setState({
      paneForegroundAgentByPaneKey: {
        [`${TAB_ID}:${LEAF_ID}`]: { agent: 'codex', shellForeground: false }
      }
    })

    await expect(pasteWithKeyboard()).resolves.toEqual({ windowsInputRecordNewline: 'alt-enter' })
  })
})
