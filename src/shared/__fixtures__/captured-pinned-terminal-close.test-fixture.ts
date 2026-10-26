import type { TerminalSurfaceCloseIdentity } from '../terminal-tab-close'

const identity: TerminalSurfaceCloseIdentity = {
  worktreeId: 'repo-close-continuity::/tmp/terminal-close-continuity',
  tabId: 'tab-close-continuity',
  leafId: '11111111-1111-4111-8111-111111111111',
  createdAt: 1,
  generation: 0,
  hasLeaf: true,
  ptyId: 'pty-close-continuity',
  incarnationId: '22222222-2222-4222-8222-222222222222'
}

// The runtime binds its authenticated handle; every other request byte is shared across projects.
export function capturedPinnedTerminalCloseRequest(terminal = 'original-handle') {
  return {
    terminal,
    expectedIncarnationId: '22222222-2222-4222-8222-222222222222',
    originalPresentation: {
      identity: { ...identity, stablePaneId: identity.leafId },
      holders: [{ hostId: 'local' as const, identity }]
    },
    force: true as const
  }
}
