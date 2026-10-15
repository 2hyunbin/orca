// Window parity: for each stored profile, the window's startup hydration of the session as stored
// and of the shared Loader's rewrite of it (load then save) must show the same thing. Where they
// differ today, the difference is listed below with the Loader rule that causes it: as work to
// do, or as accepted with the reason it is not a bug.

import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { LEGACY_WORKSPACE_LAYOUT_PROFILES } from '../../../shared/workspace-layout/workspace-layout-legacy-profile.test-fixture'
import { loadWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-load'
import { WORKSPACE_LAYOUT_PROFILES } from '../../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import { saveWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-save'
import {
  addWorkspace,
  emptySession,
  FOLDER_KEY,
  leaf,
  SERVER_KEY,
  SSH_KEY
} from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import {
  planStartupLayoutRewrite,
  type StartupLayoutRewrite
} from '../../../shared/workspace-layout/workspace-layout-startup-rewrite'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { createTestStore } from '../store/slices/store-test-helpers'
import {
  bootWindowFromPartitions,
  diffStartupWindowViews,
  projectStartupWindowView
} from './startup-window-view.test-fixture'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreSessionMockApi()

const GIT = 'repo-1::/Users/dev/orca'
const terminal = (tabId: string) =>
  ['phone and CLI title', 'panes', 'focused pane', 'reattaches'].map(
    (field) => `${GIT} terminal ${tabId} ${field}`
  )

type KnownDifference = {
  fixture: string
  /** The Loader rule that makes the window show something else. */
  rule: string
  /** View paths that differ; see `projectStartupWindowView`. */
  paths: string[]
}

/** Differences to fix. Entries may only be removed: fix the rule, then delete its entry. */
const KNOWN_DIFFERENCES: readonly KnownDifference[] = [
  {
    fixture: 'row without a tab-bar entry or a terminal',
    rule: 'ghost tab: the Loader gives every row a tab-bar entry; the window adopts only rows it can reattach',
    paths: [`${GIT} group 0 tabs`, `${GIT} tab tab-b`, ...terminal('tab-b')]
  }
]

type AcceptedDifference = Omit<KnownDifference, 'paths'> & {
  reason: string
  /** Each differing view path with its stored and normalized values; absent means not shown. */
  values: Record<string, { stored?: unknown; normalized?: unknown }>
}

/** Differences that are not bugs: the user sees the same thing, or the window is the outlier. */
const ACCEPTED_DIFFERENCES: readonly AcceptedDifference[] = [
  {
    fixture: 'row terminal differs from its focused pane’s',
    rule: 'row.ptyId rewrite: the Loader sets the row terminal to its focused pane’s, which changes what the tab reattaches',
    reason: 'the pane’s own terminal binding wins on mount, so the user sees the same terminal',
    values: { [`${GIT} terminal tab-a reattaches`]: { stored: 'pty-stale', normalized: 'pty-a' } }
  },
  {
    fixture: 'row with no terminal while its pane has one',
    rule: 'row.ptyId rewrite: the Loader sets the row terminal to its focused pane’s, which changes what the tab reattaches',
    reason: 'the pane’s own terminal binding wins on mount, so the user sees the same terminal',
    values: { [`${GIT} terminal tab-a reattaches`]: { stored: null, normalized: 'pty-a' } }
  },
  {
    fixture: 'legacy surface tombstone on a pane still showing its terminal',
    rule: 'tombstones: the Loader closes a pane a legacy surface tombstone names; the window ignores the tombstone and shows the pane',
    reason: 'the window is the outlier: main already retires panes these tombstones name',
    values: {
      [`${GIT} group 0 tabs`]: { stored: ['tab-a', 'tab-b'], normalized: ['tab-a'] },
      [`${GIT} tab tab-b`]: {
        stored: { kind: 'terminal', shows: 'tab-b', group: 0, label: 'Terminal 2' }
      },
      [`${GIT} terminal tab-b phone and CLI title`]: { stored: 'Terminal 2' },
      [`${GIT} terminal tab-b panes`]: { stored: { pane: 'pty-b' } },
      [`${GIT} terminal tab-b focused pane`]: { stored: 'root' },
      [`${GIT} terminal tab-b reattaches`]: { stored: 'pty-b' }
    }
  },
  {
    fixture: 'tab-bar label differing from the row title',
    rule: 'label over title: the Loader writes the tab-bar label into the row title',
    reason:
      'the desktop tab shows the label, which is unchanged; only phones and the CLI show the row title',
    values: {
      [`${GIT} terminal tab-a phone and CLI title`]: { stored: 'Terminal 1', normalized: 'vim' }
    }
  }
]

/** The shared Loader's round trip, as main would persist it. */
function normalize(hostId: ExecutionHostId, session: WorkspaceSessionState): WorkspaceSessionState {
  let next = 0
  const loaded = loadWorkspaceLayout(hostId, structuredClone(session), {
    mintId: () => `minted-${++next}`,
    mintLeafId: () => `00000000-0000-4000-9000-${String(++next).padStart(12, '0')}`
  })
  return saveWorkspaceLayout(loaded)
}

const PROFILES = [...WORKSPACE_LAYOUT_PROFILES, ...LEGACY_WORKSPACE_LAYOUT_PROFILES]

describe('the window shows the same session before and after the shared Loader rewrites it', () => {
  it.each(PROFILES.map((profile) => [profile.name, profile] as const))(
    '%s',
    async (name, { hostId, build }) => {
      const stored = build()
      const storedView = projectStartupWindowView(
        await bootWindowFromPartitions(createTestStore(), [{ hostId, session: stored }])
      )
      const normalizedView = projectStartupWindowView(
        await bootWindowFromPartitions(createTestStore(), [
          { hostId, session: normalize(hostId, stored) }
        ])
      )
      // The window must show the stored workspaces at all, or an empty view hides differences.
      for (const [key, rows] of Object.entries(stored.tabsByWorktree)) {
        if (rows.length > 0) {
          expect(storedView, key).toHaveProperty([`${key} group 0 tabs`])
        }
      }
      const differences = diffStartupWindowViews(storedView, normalizedView)
      const known = KNOWN_DIFFERENCES.filter((entry) => entry.fixture === name)
      const accepted = ACCEPTED_DIFFERENCES.filter((entry) => entry.fixture === name)
      expect(
        differences.map((difference) => difference.path).sort(),
        `window differences (stored vs normalized):\n${JSON.stringify(differences, null, 2)}`
      ).toEqual(
        [
          ...known.flatMap((entry) => entry.paths),
          ...accepted.flatMap((entry) => Object.keys(entry.values))
        ].sort()
      )
      // An accepted difference stays accepted only while it shows exactly the recorded values.
      const acceptedValues = Object.assign({}, ...accepted.map((entry) => entry.values))
      expect(
        Object.fromEntries(
          differences
            .filter((difference) => difference.path in acceptedValues)
            .map(({ path, stored, normalized }) => [path, { stored, normalized }])
        )
      ).toEqual(acceptedValues)
    }
  )

  it('keeps the tab-bar twin selected when a selected legacy copy is dropped', async () => {
    const profile = PROFILES.find(
      (entry) => entry.name === 'legacy row repeating a tab-bar tab’s terminal, selected'
    )!
    const view = projectStartupWindowView(
      await bootWindowFromPartitions(createTestStore(), [
        { hostId: profile.hostId, session: normalize(profile.hostId, profile.build()) }
      ])
    )
    expect(view['active.terminal']).toBe('tab-a')
    expect(view[`${GIT} active terminal`]).toBe('tab-a')
  })

  it('restores the terminals of a session from before the tab bar, dropping its file tabs', async () => {
    const profile = PROFILES.find(
      (entry) => entry.name === 'session from before the tab bar, with an open file'
    )!
    const view = projectStartupWindowView(
      await bootWindowFromPartitions(createTestStore(), [
        { hostId: profile.hostId, session: profile.build() }
      ])
    )
    expect(view[`${GIT} group 0 tabs`]).toEqual(['tab-a', 'tab-b'])
    expect(view).not.toHaveProperty([`${GIT} tab /Users/dev/orca/src/app.ts`])
  })

  it('lists differences only for fixtures that exist', () => {
    const names = new Set(PROFILES.map((profile) => profile.name))
    expect(
      [...KNOWN_DIFFERENCES, ...ACCEPTED_DIFFERENCES].filter((entry) => !names.has(entry.fixture))
    ).toEqual([])
  })
})

/** What main's startup rewrite does with each fixture; see `planStartupLayoutRewrite`. */
const STARTUP_REWRITES: Record<string, StartupLayoutRewrite['kind']> = {
  'local desktop (git worktree, folder workspace, all tab kinds)': 'unchanged',
  'floating terminal': 'unchanged',
  'relay SSH host partition': 'unchanged',
  'remote server partition': 'unchanged',
  'empty profile': 'unchanged',
  'row without a tab-bar entry or a terminal': 'skipped',
  'row without a tab-bar entry, still bound to a terminal': 'rewrite',
  'legacy row repeating a tab-bar tab’s terminal': 'rewrite',
  'legacy row repeating a tab-bar tab’s terminal, selected': 'rewrite',
  // Window-neutral, but it rewrites a row terminal, which no persisted rule may do.
  'legacy split row sharing one pane’s terminal with a tab-bar tab': 'skipped',
  'row terminal differs from its focused pane’s': 'skipped',
  'row with no terminal while its pane has one': 'skipped',
  'tab listed by two groups, its tab-bar entry naming the second': 'rewrite',
  'session from before the tab bar, with an open file': 'skipped',
  'legacy surface tombstone on a pane still showing its terminal': 'skipped',
  'tab-bar label differing from the row title': 'skipped'
}

/** The legacy fixtures moved into each kind of partition and workspace main rewrites. */
const PARTITIONS: readonly { name: string; hostId: ExecutionHostId; key: string }[] = [
  { name: 'local git worktree', hostId: LOCAL_EXECUTION_HOST_ID, key: GIT },
  { name: 'local folder workspace', hostId: LOCAL_EXECUTION_HOST_ID, key: FOLDER_KEY },
  { name: 'relay SSH host', hostId: toSshExecutionHostId('target-1'), key: SSH_KEY },
  { name: 'remote server', hostId: toRuntimeExecutionHostId('env-1'), key: SERVER_KEY }
]

function moveTo(
  session: WorkspaceSessionState,
  key: string,
  hostId: ExecutionHostId
): WorkspaceSessionState {
  const json = JSON.stringify(session)
    .replaceAll(GIT, key)
    .replaceAll('"executionHostId":"local"', `"executionHostId":${JSON.stringify(hostId)}`)
  return JSON.parse(json)
}

describe('main rewrites a stored partition at startup only when the window shows the same', () => {
  it('names a decision for every fixture', () => {
    expect(Object.keys(STARTUP_REWRITES).sort()).toEqual(PROFILES.map((p) => p.name).sort())
  })

  it('skips every fixture whose window view differs, known or accepted', () => {
    for (const entry of [...KNOWN_DIFFERENCES, ...ACCEPTED_DIFFERENCES]) {
      expect(STARTUP_REWRITES[entry.fixture], entry.fixture).toBe('skipped')
    }
  })

  const cases = PROFILES.flatMap((profile) =>
    profile.hostId === LOCAL_EXECUTION_HOST_ID && !WORKSPACE_LAYOUT_PROFILES.includes(profile)
      ? PARTITIONS.map((partition) => ({
          label: `${partition.name}: ${profile.name}`,
          name: profile.name,
          key: partition.key,
          hostId: partition.hostId,
          build: () => moveTo(profile.build(), partition.key, partition.hostId)
        }))
      : [{ ...profile, label: profile.name, key: GIT }]
  )

  // The Loader adopts into the first group; the window into the active one.
  it('skips adopting a row into a workspace with two groups', async () => {
    const stored = addWorkspace(emptySession(), GIT, [
      {
        id: 'g1',
        tabs: [
          { id: 'tab-a', leaves: [[leaf(1), 'pty-a']] },
          { id: 'tab-b', leaves: [[leaf(2), 'pty-b']] }
        ]
      },
      { id: 'g2', tabs: [{ id: 'tab-c', leaves: [[leaf(3), 'pty-c']] }] }
    ])
    stored.unifiedTabs![GIT] = stored.unifiedTabs![GIT]!.filter((tab) => tab.id !== 'tab-b')
    stored.tabGroups![GIT]![0]!.tabOrder = ['tab-a']
    stored.activeGroupIdByWorktree = { [GIT]: 'g2' }
    expect(planStartupLayoutRewrite(LOCAL_EXECUTION_HOST_ID, stored).kind).toBe('skipped')
    const [storedView, normalizedView] = await Promise.all(
      [stored, normalize(LOCAL_EXECUTION_HOST_ID, stored)].map(async (session) =>
        projectStartupWindowView(
          await bootWindowFromPartitions(createTestStore(), [
            { hostId: LOCAL_EXECUTION_HOST_ID, session }
          ])
        )
      )
    )
    expect(diffStartupWindowViews(storedView, normalizedView)).not.toEqual([])
  })

  it.each(cases.map((entry) => [entry.label, entry] as const))(
    '%s',
    async (_label, { name, key, hostId, build }) => {
      const stored = build()
      const plan = planStartupLayoutRewrite(hostId, stored)
      expect(plan.kind).toBe(STARTUP_REWRITES[name])
      if (plan.kind !== 'rewrite') {
        return
      }
      const [storedView, rewrittenView] = await Promise.all(
        [stored, plan.session].map(async (session) =>
          projectStartupWindowView(
            await bootWindowFromPartitions(createTestStore(), [{ hostId, session }])
          )
        )
      )
      // The window must show the workspace at all, or an empty view hides differences.
      expect(storedView).toHaveProperty([`${key} group 0 tabs`])
      expect(diffStartupWindowViews(storedView, rewrittenView)).toEqual([])
      // A second boot finds nothing to rewrite, so two racing owners write the same partition.
      expect(planStartupLayoutRewrite(hostId, plan.session).kind).toBe('unchanged')
    }
  )
})
