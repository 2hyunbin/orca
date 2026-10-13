import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeMobileSessionTabMove } from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  TEST_WORKTREE_ID,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'

const LEAVES = {
  'tab-a': '11111111-1111-4111-8111-1111111111aa',
  'tab-b': '11111111-1111-4111-8111-1111111111bb',
  'tab-c': '11111111-1111-4111-8111-1111111111cc'
} as const

function terminalTab(id: keyof typeof LEAVES, sortOrder: number) {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId: TEST_WORKTREE_ID,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder,
    createdAt: sortOrder + 1
  }
}

/** A host with no window whose saved layout holds tabs a and b in one group, c in another. */
function headlessRuntime(): {
  runtime: OrcaRuntimeService
  getSession: () => WorkspaceSessionState
} {
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal({
      activeTabIdByWorktree: { [TEST_WORKTREE_ID]: 'tab-a' },
      activeGroupIdByWorktree: { [TEST_WORKTREE_ID]: 'group-a' },
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          terminalTab('tab-a', 0),
          terminalTab('tab-b', 1),
          terminalTab('tab-c', 2)
        ]
      },
      terminalLayoutsByTabId: Object.fromEntries(
        Object.entries(LEAVES).map(([tabId, leafId]) => [
          tabId,
          makeHeadlessTerminalLayout({ [leafId]: `pty-${tabId}` })
        ])
      ),
      tabGroups: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'group-a',
            worktreeId: TEST_WORKTREE_ID,
            activeTabId: 'tab-a',
            tabOrder: ['tab-a', 'tab-b']
          },
          { id: 'group-c', worktreeId: TEST_WORKTREE_ID, activeTabId: 'tab-c', tabOrder: ['tab-c'] }
        ]
      },
      tabGroupLayouts: {
        [TEST_WORKTREE_ID]: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'group-a' },
          second: { type: 'leaf', groupId: 'group-c' }
        }
      }
    })
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The runtime reads only these store methods on these paths.
  return { runtime: new OrcaRuntimeService(runtimeStore as never), getSession }
}

async function expectNoOp(move: RuntimeMobileSessionTabMove): Promise<void> {
  const { runtime, getSession } = headlessRuntime()
  await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
  const before = getSession().tabGroups
  await expect(runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, move)).resolves.toEqual({
    moved: true
  })
  expect(getSession().tabGroups).toEqual(before)
}

async function expectRefused(move: RuntimeMobileSessionTabMove, code: string): Promise<void> {
  const { runtime, getSession } = headlessRuntime()
  await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
  const before = getSession()
  await expect(runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, move)).rejects.toThrow(code)
  expect(getSession()).toBe(before)
}

describe('headless session tab moves', () => {
  it('refuses a split onto a group the host does not have', async () => {
    await expectRefused(
      { kind: 'split', tabId: 'tab-b', targetGroupId: 'group-missing', splitDirection: 'right' },
      'target_group_not_found'
    )
  })

  it('refuses a move into a group the host does not have', async () => {
    await expectRefused(
      { kind: 'move-to-group', tabId: 'tab-b', targetGroupId: 'group-missing' },
      'target_group_not_found'
    )
  })

  it('keeps a same-group drop a successful no-op', async () => {
    await expectNoOp({ kind: 'move-to-group', tabId: 'tab-b', targetGroupId: 'group-a' })
  })

  it('keeps splitting the last tab off its own group a successful no-op', async () => {
    await expectNoOp({
      kind: 'split',
      tabId: 'tab-c',
      targetGroupId: 'group-c',
      splitDirection: 'right'
    })
  })

  it('saves a move into another group with the moved tab shown there', async () => {
    const { runtime, getSession } = headlessRuntime()
    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    await runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
      kind: 'move-to-group',
      tabId: 'tab-b',
      targetGroupId: 'group-c',
      index: 0
    })

    expect(getSession().tabGroups?.[TEST_WORKTREE_ID]).toEqual([
      expect.objectContaining({ id: 'group-a', activeTabId: 'tab-a', tabOrder: ['tab-a'] }),
      expect.objectContaining({ id: 'group-c', activeTabId: 'tab-b', tabOrder: ['tab-b', 'tab-c'] })
    ])
    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(listed.tabGroups?.map(({ id, activeTabId }) => [id, activeTabId])).toEqual([
      ['group-a', 'tab-a'],
      ['group-c', 'tab-b']
    ])
  })

  it("shows the mover a tab it moved into another group, over the device's own pick", async () => {
    const { runtime } = headlessRuntime()
    const groupsSeenBy = async (device: string) =>
      (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`, device)).tabGroups?.map(
        ({ id, activeTabId }) => [id, activeTabId]
      )
    // Each device's first list records its own pick per group.
    expect(await groupsSeenBy('phone')).toEqual([
      ['group-a', 'tab-a'],
      ['group-c', 'tab-c']
    ])
    await groupsSeenBy('tablet')

    await runtime.moveMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      { kind: 'move-to-group', tabId: 'tab-b', targetGroupId: 'group-c', index: 0 },
      'phone'
    )

    expect(await groupsSeenBy('phone')).toEqual([
      ['group-a', 'tab-a'],
      ['group-c', 'tab-b']
    ])
    expect(await groupsSeenBy('tablet')).toEqual([
      ['group-a', 'tab-a'],
      ['group-c', 'tab-c']
    ])
  })

  it('shows the mover a tab it reordered, as a drag selects it', async () => {
    const { runtime } = headlessRuntime()
    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`, 'phone')

    await runtime.moveMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      { kind: 'reorder', tabId: 'tab-b', targetGroupId: 'group-a', tabOrder: ['tab-b', 'tab-a'] },
      'phone'
    )

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`, 'phone')
    expect(listed.tabGroups?.[0]).toMatchObject({
      activeTabId: 'tab-b',
      tabOrder: ['tab-b', 'tab-a']
    })
  })
})
