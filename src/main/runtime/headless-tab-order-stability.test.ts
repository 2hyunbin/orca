import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

const WT = 'repo-1::/home/orca/worktree'
const leafOf = (n: number): string => `${n}${n}${n}${n}${n}${n}${n}${n}-1111-4111-8111-111111111111`

const terminalRow = (n: number) => ({
  id: `tab-${n}`,
  ptyId: `pty-${n}`,
  worktreeId: WT,
  title: `terminal ${n}`,
  customTitle: null,
  color: null,
  sortOrder: n,
  createdAt: 1
})

const unifiedRow = (n: number, groupId: string) => ({
  id: `tab-${n}`,
  entityId: `tab-${n}`,
  groupId,
  worktreeId: WT,
  contentType: 'terminal' as const,
  label: `terminal ${n}`,
  customLabel: null,
  color: null,
  sortOrder: n,
  createdAt: 1
})

/** Saved tabs 1-4 grouped as `groups` (group id -> tab numbers in display order). */
function runtimeWithGroups(groups: Record<string, number[]>): OrcaRuntimeService {
  const numbers = Object.values(groups).flat()
  const groupIds = Object.keys(groups)
  let session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: { [WT]: numbers.map(terminalRow) },
    terminalLayoutsByTabId: Object.fromEntries(
      numbers.map((n) => [
        `tab-${n}`,
        {
          root: { type: 'leaf', leafId: leafOf(n) },
          activeLeafId: leafOf(n),
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafOf(n)]: `pty-${n}` }
        }
      ])
    ),
    unifiedTabs: {
      [WT]: Object.entries(groups).flatMap(([groupId, tabs]) =>
        tabs.map((n) => unifiedRow(n, groupId))
      )
    },
    tabGroups: {
      [WT]: Object.entries(groups).map(([id, tabs]) => ({
        id,
        worktreeId: WT,
        activeTabId: `tab-${tabs[0]}`,
        tabOrder: tabs.map((n) => `tab-${n}`)
      }))
    },
    tabGroupLayouts: {
      [WT]:
        groupIds.length > 1
          ? {
              type: 'split',
              direction: 'horizontal',
              first: { type: 'leaf', groupId: groupIds[0]! },
              second: { type: 'leaf', groupId: groupIds[1]! }
            }
          : { type: 'leaf', groupId: groupIds[0]! }
    },
    activeGroupIdByWorktree: { [WT]: groupIds[0]! }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only the workspace session and repo list in this suite.
  const runtime = new OrcaRuntimeService({
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    },
    getRepos: () => [{ id: 'repo-1' }],
    getAllWorktreeMeta: () => ({}),
    getSettings: () => ({ workspaceDir: '/tmp/workspaces' })
  } as never)
  // Live terminals: activating one only selects it, never respawns it.
  for (const n of numbers) {
    runtime.registerPty(`pty-${n}`, WT)
  }
  return runtime
}

async function groupOrders(runtime: OrcaRuntimeService): Promise<Record<string, string[]>> {
  const result = await runtime.listMobileSessionTabs(`id:${WT}`)
  return Object.fromEntries((result.tabGroups ?? []).map((group) => [group.id, group.tabOrder]))
}

describe('headless tab order stability', () => {
  it('retains order when activating a later tab', async () => {
    const runtime = runtimeWithGroups({ main: [1, 2, 3, 4] })
    const before = await groupOrders(runtime)
    expect(before.main).toEqual(['tab-1', 'tab-2', 'tab-3', 'tab-4'])

    await runtime.activateMobileSessionTab(`id:${WT}`, 'tab-2', leafOf(2))

    expect(await groupOrders(runtime)).toEqual(before)
    expect((await runtime.listMobileSessionTabs(`id:${WT}`)).activeTabId).toBe(
      `tab-2::${leafOf(2)}`
    )
  })

  it('retains order independently in split groups', async () => {
    const runtime = runtimeWithGroups({ left: [1, 2], right: [3, 4] })

    await runtime.activateMobileSessionTab(`id:${WT}`, 'tab-4', leafOf(4))

    expect(await groupOrders(runtime)).toEqual({
      left: ['tab-1', 'tab-2'],
      right: ['tab-3', 'tab-4']
    })
  })
})
