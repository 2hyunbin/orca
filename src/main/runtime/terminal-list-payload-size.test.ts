import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

// Measures the real `terminal.list` wire payload for a large listing, so the
// visualLayouts opt-out keeps paying for itself. Sized against a live
// 134-terminal remote runtime (137,412 B on the wire, visualLayouts 44,208 B).
const TERMINAL_COUNT = 134
const PANES_PER_TAB = 2
const TAB_COUNT = TERMINAL_COUNT / PANES_PER_TAB
// Leaves ~19% headroom over the measured 75,467 B while catching material bloat.
const MAX_OPTED_OUT_PAYLOAD_BYTES = 90_000
const REPO_ID = 'repo-7f3a91c2e4b85d60'
const WORKTREE_PATH = '/Users/dev/orca/workspaces/orca/perf-terminal-list-diet'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`

const uuid = (n: number): string => {
  const hex = n.toString(16).padStart(12, '0')
  return `11111111-1111-4111-8111-${hex}`
}

const leafIdFor = (index: number): string => uuid(index)
const tabIdFor = (tab: number): string => `tab-${uuid(1_000 + tab)}`
const ptyIdFor = (index: number): string => `pty-${uuid(2_000 + index)}`
const groupIdFor = (tab: number): string => `group-${uuid(3_000 + (tab % 2))}`
const titleFor = (index: number): string => `claude — orca/perf-terminal-list-diet #${index}`

const makeStore = (session: WorkspaceSessionState = getDefaultWorkspaceSession()) => ({
  getWorkspaceSession: () => session,
  setWorkspaceSession: (next: WorkspaceSessionState) => {
    session = next
  },
  getRepo: (id: string) => makeStore().getRepos()[0] ?? (id as never),
  getRepos: () => [
    { id: REPO_ID, path: '/tmp/repo', displayName: 'repo', badgeColor: 'blue', addedAt: 1 }
  ],
  addRepo: () => {},
  updateRepo: (id: string) => makeStore().getRepo(id) as never,
  getAllWorktreeMeta: () => ({
    [WORKTREE_ID]: {
      displayName: 'foo',
      comment: '',
      linkedIssue: 123,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0
    }
  }),
  getWorktreeMeta: (worktreeId: string) =>
    (makeStore().getAllWorktreeMeta() as Record<string, unknown>)[worktreeId] as never,
  setWorktreeMeta: () => ({}) as never,
  removeWorktreeMeta: () => {},
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    branchPrefix: 'none',
    branchPrefixCustom: ''
  })
})

type PaneLayout =
  | { type: 'leaf'; leafId: string }
  | { type: 'split'; direction: 'vertical'; first: PaneLayout; second: PaneLayout }

type GraphTab = {
  tabId: string
  worktreeId: string
  title: string
  activeLeafId: string
  layout: PaneLayout
}

type GraphLeaf = {
  tabId: string
  worktreeId: string
  leafId: string
  paneRuntimeId: number
  ptyId: string
  title: string
}

function buildLoadedRuntime(): OrcaRuntimeService {
  const tabs: GraphTab[] = []
  const leaves: GraphLeaf[] = []
  const groupIds = [groupIdFor(0), groupIdFor(1)]
  // The window's saved session, which the phone list and visualLayouts project.
  const session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: { [WORKTREE_ID]: [] },
    unifiedTabs: { [WORKTREE_ID]: [] },
    tabGroups: {
      [WORKTREE_ID]: groupIds.map((id, groupIndex) => ({
        id,
        worktreeId: WORKTREE_ID,
        activeTabId: tabIdFor(groupIndex),
        tabOrder: []
      }))
    },
    tabGroupLayouts: {
      [WORKTREE_ID]: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: groupIds[0]! },
        second: { type: 'leaf', groupId: groupIds[1]! }
      }
    },
    activeGroupIdByWorktree: { [WORKTREE_ID]: groupIds[0]! }
  }

  for (let tab = 0; tab < TAB_COUNT; tab += 1) {
    const tabId = tabIdFor(tab)
    const first = leafIdFor(tab * PANES_PER_TAB)
    const second = leafIdFor(tab * PANES_PER_TAB + 1)
    const root: PaneLayout = {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: first },
      second: { type: 'leaf', leafId: second }
    }
    tabs.push({
      tabId,
      worktreeId: WORKTREE_ID,
      title: `Tab ${tab}`,
      activeLeafId: second,
      layout: root
    })
    const groupId = groupIds[tab % 2]!
    session.tabsByWorktree[WORKTREE_ID]!.push({
      id: tabId,
      ptyId: ptyIdFor(tab * PANES_PER_TAB),
      worktreeId: WORKTREE_ID,
      title: `Tab ${tab}`,
      customTitle: null,
      color: null,
      sortOrder: tab,
      createdAt: 1
    })
    session.unifiedTabs![WORKTREE_ID]!.push({
      id: tabId,
      entityId: tabId,
      groupId,
      worktreeId: WORKTREE_ID,
      contentType: 'terminal',
      label: `Tab ${tab}`,
      customLabel: null,
      color: null,
      sortOrder: tab,
      createdAt: 1
    })
    session.tabGroups![WORKTREE_ID]!.find((group) => group.id === groupId)!.tabOrder.push(tabId)
    session.terminalLayoutsByTabId[tabId] = {
      root,
      activeLeafId: second,
      expandedLeafId: null,
      ptyIdsByLeafId: {
        [first]: ptyIdFor(tab * PANES_PER_TAB),
        [second]: ptyIdFor(tab * PANES_PER_TAB + 1)
      },
      titlesByLeafId: {
        [first]: titleFor(tab * PANES_PER_TAB),
        [second]: titleFor(tab * PANES_PER_TAB + 1)
      }
    }
    for (let pane = 0; pane < PANES_PER_TAB; pane += 1) {
      const index = tab * PANES_PER_TAB + pane
      leaves.push({
        tabId,
        worktreeId: WORKTREE_ID,
        leafId: leafIdFor(index),
        paneRuntimeId: pane + 1,
        ptyId: ptyIdFor(index),
        title: titleFor(index)
      })
    }
  }

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime never calls getGitHubCache, the one RuntimeStore member this stub omits.
  const runtime = new OrcaRuntimeService(makeStore(session) as never)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs, leaves })

  // Realistic previews: the live sample carried ~27 B of tail text per terminal.
  for (let index = 0; index < TERMINAL_COUNT; index += 1) {
    const ptyId = ptyIdFor(index)
    runtime.registerPty(ptyId, WORKTREE_ID)
    runtime.onPtySpawned(ptyId, `inc-${uuid(4_000 + index)}`, { awaitsRegistration: false })
    runtime.onPtyData(ptyId, `esc to interrupt · ${index}\n`, 1)
  }
  return runtime
}

describe('terminal.list payload size', () => {
  it('drops ~30% of the wire payload when a caller opts out of visualLayouts', async () => {
    const runtime = buildLoadedRuntime()

    const withLayouts = await runtime.listTerminals(`id:${WORKTREE_ID}`, 10_000)
    const layoutBuilder = vi.fn(() => [])
    Object.defineProperty(runtime, 'buildTerminalVisualLayouts', { value: layoutBuilder })
    const withoutLayouts = await runtime.listTerminals(`id:${WORKTREE_ID}`, 10_000, {
      includeVisualLayouts: false
    })
    const { visualLayouts, ...expectedWithoutLayouts } = withLayouts

    expect(withLayouts.terminals).toHaveLength(TERMINAL_COUNT)
    expect(visualLayouts).toHaveLength(1)
    expect(withoutLayouts).toEqual(expectedWithoutLayouts)
    expect(layoutBuilder).not.toHaveBeenCalled()

    const beforeBytes = Buffer.byteLength(JSON.stringify(withLayouts), 'utf8')
    const afterBytes = Buffer.byteLength(JSON.stringify(withoutLayouts), 'utf8')
    const layoutBytes = Buffer.byteLength(JSON.stringify(withLayouts.visualLayouts), 'utf8')
    const reduction = (beforeBytes - afterBytes) / beforeBytes

    console.log(
      `terminal.list ${TERMINAL_COUNT} terminals: ${beforeBytes} B -> ${afterBytes} B ` +
        `(-${(reduction * 100).toFixed(1)}%); visualLayouts alone ${layoutBytes} B`
    )

    expect(beforeBytes).toBeGreaterThan(100_000)
    expect(afterBytes).toBeLessThanOrEqual(MAX_OPTED_OUT_PAYLOAD_BYTES)
    expect(reduction).toBeGreaterThan(0.25)
  })
})
