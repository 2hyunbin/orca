// Today's graph mirror, captured from OrcaRuntimeService.syncWindowGraph: tab-1 splits a live
// terminal (output and an OSC title) beside one that exited 1; tab-2 has one unbound pane. Step 2
// restarts the exited pane on a new terminal. runtime-graph-mirror-capture.test.ts replays this on
// the mirror and checks every record here; the projection is checked against the same records.

import type { PtyLivenessVerdict } from '../../shared/pty-liveness-verdict'
import type { RuntimeSyncedLeaf, RuntimeSyncedTab } from '../../shared/runtime-types'
import type { RuntimeLeafPtyFacts } from './runtime-leaf-record-projection'
import type { RuntimeLeafRecord } from './runtime-terminal-state-records'

export const WORKTREE_ID = 'repo-1::/Users/dev/orca'
export const LEAF_1 = '11111111-1111-4111-8111-111111111111'
export const LEAF_2 = '22222222-2222-4222-8222-222222222222'
export const LEAF_3 = '33333333-3333-4333-8333-333333333333'

export const PTY_A_OUTPUT = '\x1b]0;build watch\x07hello\r\nworld\r\n'

export const TAB_1_ROOT = {
  type: 'split',
  direction: 'vertical',
  first: { type: 'leaf', leafId: LEAF_1 },
  second: { type: 'leaf', leafId: LEAF_2 }
} as const

/** The tabs the window publishes, and the mirror keeps unchanged. */
export const MIRROR_TABS: RuntimeSyncedTab[] = [
  {
    tabId: 'tab-1',
    worktreeId: WORKTREE_ID,
    title: 'build watch',
    activeLeafId: LEAF_2,
    layout: TAB_1_ROOT
  },
  {
    tabId: 'tab-2',
    worktreeId: WORKTREE_ID,
    title: 'Terminal 2',
    activeLeafId: LEAF_3,
    layout: { type: 'leaf', leafId: LEAF_3 }
  }
]

const PUBLISHED_1: RuntimeSyncedLeaf = {
  tabId: 'tab-1',
  worktreeId: WORKTREE_ID,
  leafId: LEAF_1,
  paneRuntimeId: 1,
  ptyId: 'pty-a',
  paneTitle: 'build watch',
  title: 'build watch'
}
const PUBLISHED_2: RuntimeSyncedLeaf = {
  tabId: 'tab-1',
  worktreeId: WORKTREE_ID,
  leafId: LEAF_2,
  paneRuntimeId: 2,
  ptyId: 'pty-b',
  paneTitle: null,
  title: 'build watch'
}
const PUBLISHED_3: RuntimeSyncedLeaf = {
  tabId: 'tab-2',
  worktreeId: WORKTREE_ID,
  leafId: LEAF_3,
  paneRuntimeId: 1,
  ptyId: null,
  paneTitle: null,
  title: 'Terminal 2'
}

/** The leaves the window publishes in step 1; step 2 binds LEAF_2 to pty-c. */
export const PUBLISHED_LEAVES = [PUBLISHED_1, PUBLISHED_2, PUBLISHED_3]

const NO_TAIL = {
  tailBuffer: [],
  tailTranscriptBuffer: [],
  tailTranscriptChars: 0,
  tailPartialLine: '',
  tailPendingAnsi: '',
  tailRedrawCursor: null,
  tailTruncated: false,
  tailLinesTotal: 0,
  waitBlockedAt: null
}

/** The PTY records' leaf facts after each step; pty-a and pty-b do not change in step 2. */
export const PTY_FACTS: Record<'pty-a' | 'pty-b' | 'pty-c', RuntimeLeafPtyFacts> = {
  'pty-a': {
    ...NO_TAIL,
    connected: true,
    lastOutputAt: 1000,
    lastExitCode: null,
    lastExitCause: null,
    tailBuffer: ['hello', 'world'],
    tailTranscriptBuffer: ['hello', 'world'],
    tailTranscriptChars: 10,
    tailLinesTotal: 2,
    preview: 'hello\nworld',
    lastAgentStatus: null,
    lastAgentStatusObservedLive: true,
    lastOscTitle: 'build watch',
    lastOscTitleAt: 1
  },
  'pty-b': {
    ...NO_TAIL,
    connected: false,
    lastOutputAt: 2000,
    lastExitCode: 1,
    lastExitCause: { kind: 'exited', exitCode: 1 },
    preview: 'done',
    lastAgentStatus: null,
    lastAgentStatusObservedLive: false,
    lastOscTitle: null,
    lastOscTitleAt: null
  },
  'pty-c': {
    ...NO_TAIL,
    connected: true,
    lastOutputAt: 3000,
    lastExitCode: null,
    lastExitCause: null,
    tailBuffer: ['restarted'],
    tailTranscriptBuffer: ['restarted'],
    tailTranscriptChars: 9,
    tailLinesTotal: 1,
    preview: 'restarted',
    lastAgentStatus: null,
    lastAgentStatusObservedLive: false,
    lastOscTitle: null,
    lastOscTitleAt: null
  }
}

export const LIVENESS_VERDICTS: Record<string, PtyLivenessVerdict | null> = {
  'pty-a': null,
  'pty-b': { status: 'exited' },
  'pty-c': null
}

function mirrorLeaf(
  published: RuntimeSyncedLeaf,
  facts: Omit<RuntimeLeafPtyFacts, 'connected'> | null,
  leaf: Pick<RuntimeLeafRecord, 'ptyGeneration' | 'connected' | 'paneTitleUpdatedAt'>
): RuntimeLeafRecord {
  return {
    ...published,
    ...NO_TAIL,
    preview: '',
    lastOutputAt: null,
    lastExitCode: null,
    lastExitCause: null,
    lastAgentStatus: null,
    lastAgentStatusObservedLive: false,
    lastOscTitle: null,
    lastOscTitleAt: null,
    ...facts,
    ...leaf,
    writable: leaf.connected
  }
}

function withoutConnected({
  connected: _connected,
  ...facts
}: RuntimeLeafPtyFacts): Omit<RuntimeLeafPtyFacts, 'connected'> {
  return facts
}

/** `paneTitleUpdatedAt` is the title observation sequence at the graph sync that saw the title. */
const MIRROR_LEAF_1 = mirrorLeaf(PUBLISHED_1, withoutConnected(PTY_FACTS['pty-a']), {
  ptyGeneration: 0,
  connected: true,
  paneTitleUpdatedAt: 2
})
const MIRROR_LEAF_3 = mirrorLeaf(PUBLISHED_3, null, {
  ptyGeneration: 0,
  connected: false,
  paneTitleUpdatedAt: 2
})

export const MIRROR_LEAVES_STEP_1: RuntimeLeafRecord[] = [
  MIRROR_LEAF_1,
  mirrorLeaf(PUBLISHED_2, withoutConnected(PTY_FACTS['pty-b']), {
    ptyGeneration: 0,
    connected: false,
    paneTitleUpdatedAt: 2
  }),
  MIRROR_LEAF_3
]

export const MIRROR_LEAVES_STEP_2: RuntimeLeafRecord[] = [
  MIRROR_LEAF_1,
  mirrorLeaf({ ...PUBLISHED_2, ptyId: 'pty-c' }, withoutConnected(PTY_FACTS['pty-c']), {
    ptyGeneration: 1,
    connected: true,
    paneTitleUpdatedAt: 3
  }),
  MIRROR_LEAF_3
]
