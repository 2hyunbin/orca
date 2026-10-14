import { vi, type Mock } from 'vitest'
import type { AppState } from '../../types'
import { applyAgentAttentionUnread, applyTerminalBell } from './subject-attention-marks'
import type { WorkspaceAttentionWriters } from './workspace-attention-contract'

// Why `vi.fn()` mocks: the doubles that host these spies type every action that way.
type WriterSpy = ReturnType<typeof vi.fn>

type WriterSpyState = {
  settings?: { experimentalTerminalAttention?: boolean } | null
  markWorktreeUnread: WriterSpy
  markTerminalTabUnread: WriterSpy
  markTerminalPaneUnread: WriterSpy
  markAgentCompletionPaneUnread?: WriterSpy
}

/**
 * Mocked-store doubles for the attention events that run the real composition rules over spies,
 * so a test can still assert which workspace, tab, pane and completion writes an event made.
 */
export function attentionEventsOverWriterSpies(getState: () => WriterSpyState): {
  markTerminalBell: Mock<AppState['markTerminalBell']>
  markAgentAttentionUnread: Mock<AppState['markAgentAttentionUnread']>
} {
  const writers = (): WorkspaceAttentionWriters => {
    const state = getState()
    // Why Reflect.apply: a bare `vi.fn()` is typed callable-or-constructable, so it cannot be called directly.
    const call = (spy: WriterSpy | undefined, ...args: unknown[]): void => {
      if (spy) {
        Reflect.apply(spy, undefined, args)
      }
    }
    return {
      markWorkspaceUnread: (worktreeId) => call(state.markWorktreeUnread, worktreeId),
      markTabUnread: (tabId, reason) => call(state.markTerminalTabUnread, tabId, reason),
      markPaneUnread: (paneKey, reason) => call(state.markTerminalPaneUnread, paneKey, reason),
      markCompletionUnread: (paneKey, reason) =>
        call(state.markAgentCompletionPaneUnread, paneKey, reason)
    }
  }
  return {
    markTerminalBell: vi.fn<AppState['markTerminalBell']>((target) =>
      applyTerminalBell(
        target,
        getState().settings?.experimentalTerminalAttention === true,
        writers()
      )
    ),
    markAgentAttentionUnread: vi.fn<AppState['markAgentAttentionUnread']>((write) =>
      applyAgentAttentionUnread(write, writers())
    )
  }
}
