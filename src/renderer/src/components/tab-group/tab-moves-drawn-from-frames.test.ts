// A tab move in a layout-owner build: main applies it and its frame draws it; on main's answer the
// window selects the moved tab. Main's frames run through the shared transport, whose apply check
// fails any flush that differs from the full build.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { useAppStore } from '@/store'
import { localDesktopSession } from '../../../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import { GIT_KEY } from '../../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { bootWindowFromPartitions } from '../../app-shell/startup-window-view.test-fixture'
import { createStoreSessionMockApi } from '../../store/slices/store-session-test-harness'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { loadMainLayoutModel } from '@/runtime/main-loaded-layout-frames.test-fixture'
import { endLayoutFramePositions } from '@/runtime/layout-frame-position'
import { openWorkspaceLayoutFrameSync } from '@/runtime/workspace-layout-frame-sync'
import { dropTabThroughLayoutOwner } from './tab-group-layout-owner-commands'
import { moveTabToNewPaneColumn } from '../tab-bar/tab-move-to-pane-column'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
// Main's answer to the window's layout commands and its frames, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreSessionMockApi()

const settle = async (): Promise<void> => {
  await layoutApplyTestTransport.settle()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

let close = (): void => {}

beforeEach(async () => {
  layoutApplyTestTransport.reset()
  const session = localDesktopSession()
  layoutApplyTestTransport.useMainModel(loadMainLayoutModel('local', session))
  layoutApplyTestTransport.answerWith('apply')
  await bootWindowFromPartitions(useAppStore, [{ hostId: 'local', session }])
  const sync = openWorkspaceLayoutFrameSync(useAppStore)
  sync.start()
  await settle()
  close = () => sync.close()
})

afterEach(() => {
  close()
  endLayoutFramePositions()
})

const tabOf = (tabId: string) =>
  useAppStore.getState().unifiedTabsByWorktree[GIT_KEY]!.find((tab) => tab.id === tabId)!
const groupOf = (groupId: string) =>
  useAppStore.getState().groupsByWorktree[GIT_KEY]!.find((group) => group.id === groupId)
const mainGroupOf = (tabId: string) =>
  layoutApplyTestTransport.mainModel!.workspaces[GIT_KEY]!.groups.find((group) =>
    group.tabOrder.includes(tabId)
  )!

describe('a tab move drawn from main’s frame', () => {
  it('moves the tab into another group where main placed it, and selects it there', async () => {
    expect(
      dropTabThroughLayoutOwner(GIT_KEY, {
        kind: 'move',
        tabId: 'tab-unbound',
        groupId: 'group-a',
        index: 0
      })
    ).toBe(true)
    await settle()

    expect(tabOf('tab-unbound').groupId).toBe('group-a')
    expect(groupOf('group-a')!.tabOrder).toEqual(mainGroupOf('tab-unbound').tabOrder)
    expect(groupOf('group-a')!.tabOrder[0]).toBe('tab-unbound')
    expect(groupOf('group-a')!.activeTabId).toBe('tab-unbound')
    expect(useAppStore.getState().activeGroupIdByWorktree[GIT_KEY]).toBe('group-a')
  })

  it('splits the tab into the group main made beside its target, and selects it there', async () => {
    const groupsBefore = useAppStore.getState().groupsByWorktree[GIT_KEY]!.map((group) => group.id)
    dropTabThroughLayoutOwner(GIT_KEY, {
      kind: 'split',
      tabId: 'tab-unbound',
      groupId: 'group-a',
      direction: 'right'
    })
    await settle()

    const mainGroup = mainGroupOf('tab-unbound')
    expect(groupsBefore).not.toContain(mainGroup.id)
    expect(tabOf('tab-unbound').groupId).toBe(mainGroup.id)
    expect(groupOf(mainGroup.id)!.tabOrder).toEqual(['tab-unbound'])
    expect(useAppStore.getState().layoutByWorktree[GIT_KEY]).toEqual(
      layoutApplyTestTransport.mainModel!.workspaces[GIT_KEY]!.groupLayout
    )
    expect(useAppStore.getState().activeGroupIdByWorktree[GIT_KEY]).toBe(mainGroup.id)
  })

  it('moves a tab to a split from its menu where main placed it', async () => {
    expect(
      moveTabToNewPaneColumn({ unifiedTabId: 'tab-shell', groupId: 'group-a', direction: 'down' })
    ).toBe(true)
    await settle()

    expect(layoutApplyTestTransport.sentOfType('splitGroup')).toEqual([
      expect.objectContaining({ tabId: 'tab-shell', besideGroupId: 'group-a', direction: 'down' })
    ])
    const mainGroup = mainGroupOf('tab-shell')
    expect(mainGroup.id).not.toBe('group-a')
    expect(tabOf('tab-shell').groupId).toBe(mainGroup.id)
    expect(useAppStore.getState().activeGroupIdByWorktree[GIT_KEY]).toBe(mainGroup.id)
  })

  it('reorders the tab within its group as main ordered it', async () => {
    dropTabThroughLayoutOwner(GIT_KEY, {
      kind: 'reorder',
      tabId: 'tab-shell',
      groupId: 'group-a',
      tabOrder: ['tab-agent', 'tab-shell', 'editor:src/app.ts']
    })
    await settle()

    expect(groupOf('group-a')!.tabOrder).toEqual(['tab-agent', 'tab-shell', 'editor:src/app.ts'])
  })

  it('moves the tab itself while main’s stream is down', async () => {
    endLayoutFramePositions()
    dropTabThroughLayoutOwner(GIT_KEY, {
      kind: 'move',
      tabId: 'tab-unbound',
      groupId: 'group-a',
      index: 0
    })
    await settle()

    expect(tabOf('tab-unbound').groupId).toBe('group-a')
  })
})
