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

export const pairedWriterFixture = {
  worktreeId:
    'b81f465d-0784-4d4a-9a06-7c5bb2275b8d::/Users/m4air/orca/workspaces/orca/qa-pr-33721-qg',
  tabId: 'c1559044-c0d2-48bc-a076-5fdfed85e61a',
  leafId: '3286ffd0-b135-42a0-86c3-037dc4a24f32',
  incarnationId: '8f582c24-8528-408f-8e9f-761b11714f62',
  handle: 'term_a16f6b57-9771-4c4f-bbe2-108e9ca50400',
  ptyId:
    'b81f465d-0784-4d4a-9a06-7c5bb2275b8d::/Users/m4air/orca/workspaces/orca/qa-pr-33721-qg@@f35f6ef7'
} as const

export const pairedWriterHoldingTerminal = {
  worktreeId: pairedWriterFixture.worktreeId,
  paneKey: `${pairedWriterFixture.tabId}:${pairedWriterFixture.leafId}`,
  incarnationId: pairedWriterFixture.incarnationId
}
