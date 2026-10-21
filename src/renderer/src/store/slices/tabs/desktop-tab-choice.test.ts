import { desktopChosenTabId } from './desktop-tab-choice'
import { chooseWorkspaceTab } from '@/lib/workspace-tab-commands'
import type { AppState } from '@/store/types'
import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/runtime-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { loadWorkspaceLayoutWithoutReport } from '../../../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../../../shared/workspace-layout/workspace-layout-minted-ids'
import { publishWorkspaceLayout } from '../../../../../shared/workspace-layout/workspace-layout-published'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { makeWorktree, REPO_ID } from '@/runtime/host-session-mirror-frame-fixtures'
import { projectLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync/snapshot-projection'
import { applyWebSessionTabsSnapshot } from '@/runtime/web-session-tabs-sync/snapshot-api'
import { buildLayoutFrameSlices } from '../../workspace-layout-frame-slices'
import { createStoreSessionMockApi } from '../store-session-test-harness'
import { createTestStore } from '../store-test-helpers'
import { deriveActiveSurfaceForWorktree } from './tabs-surface'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreSessionMockApi()

const WT = `${REPO_ID}::/workspace/created-from-phone`
const OTHER = `${REPO_ID}::/workspace/where-the-desktop-is`
const worktreesByRepo = {
  [REPO_ID]: [
    {
      ...makeWorktree(WT, '/workspace/created-from-phone'),
      hostId: LOCAL_EXECUTION_HOST_ID,
      createdWithAgent: 'claude' as const
    },
    makeWorktree(OTHER, '/workspace/where-the-desktop-is')
  ]
} satisfies AppState['worktreesByRepo']
const chat = { type: 'agent-session', id: 'chat-1', sessionId: 's-1', agent: 'claude' } as const
const chatArrives = {
  worktree: WT,
  publicationEpoch: 'structured:epoch-1',
  snapshotVersion: 1,
  activeTabId: chat.id,
  activeTabType: 'agent-session',
  activeGroupId: null,
  tabs: [{ ...chat, title: 'Claude', isActive: false }]
} satisfies RuntimeMobileSessionTabsResult
type Saved = ReturnType<typeof buildWorkspaceSessionPayload>

function reloaded(saved: Saved) {
  const store = createTestStore()
  store.setState({ worktreesByRepo, activeWorktreeId: OTHER, activeTabId: 'other-terminal' })
  store.setState({ tabsByWorktree: saved.tabsByWorktree })
  store.getState().hydrateTabsSession(saved)
  store.getState().reconcileWorktreeTabModel(WT)
  return store.getState()
}

function shown(state: ReturnType<typeof reloaded>) {
  const groupId = state.activeGroupIdByWorktree[WT]
  const tabId = state.groupsByWorktree[WT]!.find((group) => group.id === groupId)?.activeTabId
  return { tabId, type: deriveActiveSurfaceForWorktree(state, WT).activeTabType }
}

/** The layout-owner build: frames carry no selection, so the view read back from the save decides. */
function shownByFrames(saved: Saved, choices: ReturnType<typeof reloaded>) {
  const host = LOCAL_EXECUTION_HOST_ID
  const { layout, facts, desktopView } = loadWorkspaceLayoutWithoutReport(
    host,
    saved,
    nameBasedLoadContext()
  )
  const layouts = { [WT]: publishWorkspaceLayout(layout.workspaces[WT]!, host) }
  const slices = buildLayoutFrameSlices({ layouts, facts, view: desktopView, choices })
  return slices.groupsByWorktree[WT]![0]!.activeTabId
}

describe('a workspace this window has not chosen a tab in', () => {
  // The bug: a phone-created workspace opened on Setup on the desktop, never on its agent chat.
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true]
  ])(
    'opens on its late agent across a reload (picked=%s, terminal=%s)',
    (clickedSetup, terminal) => {
      const store = createTestStore()
      store.setState({ worktreesByRepo, activeWorktreeId: OTHER, activeTabId: 'other-terminal' })
      const setup = store.getState().createTab(WT, undefined, undefined, {
        activate: false,
        recordInteraction: false
      })
      if (clickedSetup) {
        // A click on the Setup already shown is still this window's choice.
        chooseWorkspaceTab(WT, setup.id, store)
      }

      if (!clickedSetup) {
        store.getState().openFile(
          {
            filePath: '/workspace/background.md',
            relativePath: 'background.md',
            worktreeId: WT,
            language: 'markdown',
            mode: 'edit'
          },
          { selection: 'background' }
        )
        expect(desktopChosenTabId(store.getState(), WT)).toBeNull()
      }
      // Saved and reloaded while only Setup exists; then the chat arrives.
      const before = reloaded(buildWorkspaceSessionPayload(store.getState()))
      const projected = terminal
        ? {
            ...chatArrives,
            activeTabType: 'terminal' as const,
            tabs: [
              {
                type: 'terminal' as const,
                id: 'agent::leaf',
                parentTabId: 'agent',
                leafId: 'leaf',
                title: 'Claude',
                launchAgent: 'claude',
                terminal: 'pty-agent',
                status: 'ready' as const,
                isActive: false
              }
            ]
          }
        : projectLocalStructuredSessionTabs(chatArrives)
      const options = {
        contentScope: terminal ? 'all' : 'agent-session',
        preserveLocalLayout: true,
        terminalPtyMode: 'local'
      } as const
      const after = {
        ...before,
        ...applyWebSessionTabsSnapshot(before, projected, 'local', 1, options)
      }
      const chatTab = after.unifiedTabsByWorktree[WT]!.find((tab) =>
        terminal
          ? tab.contentType === 'terminal' && tab.entityId !== setup.id
          : tab.entityId === chat.sessionId
      )
      const expected = clickedSetup
        ? { tabId: setup.id, type: 'terminal' }
        : { tabId: chatTab?.id, type: terminal ? 'terminal' : 'agent-session' }
      expect(shown(after)).toEqual(expected)
      expect([after.activeWorktreeId, after.activeTabId]).toEqual([OTHER, 'other-terminal'])

      // A second save and reload, and the layout-owner build's frames, keep it derived.
      const resaved = buildWorkspaceSessionPayload(after)
      expect(shown(reloaded(resaved))).toEqual(expected)
      expect(shownByFrames(resaved, after)).toBe(expected.tabId)
    }
  )
})

// A transient publisher omission changes display, never the saved choice.
it('returns to a temporarily absent explicit tab after saving and reloading its fallback', () => {
  const store = createTestStore()
  store.setState({ worktreesByRepo, activeWorktreeId: OTHER, activeTabId: 'other-terminal' })
  store.getState().createTab(WT, undefined, undefined, { activate: false })
  const picked = store.getState().createTab(WT, undefined, undefined, { activate: false })
  chooseWorkspaceTab(WT, picked.id, store)
  const present = store.getState().unifiedTabsByWorktree[WT]!
  const terminals = store.getState().tabsByWorktree[WT]!
  store.setState({
    unifiedTabsByWorktree: { [WT]: present.filter((tab) => tab.entityId !== picked.id) }
  })
  store.getState().reconcileWorktreeTabModel(WT)
  const saved = buildWorkspaceSessionPayload(store.getState())
  expect(saved.tabGroups?.[WT]?.some((group) => group.activeTabId === picked.id)).toBe(true)
  const restored = createTestStore()
  restored.setState({ worktreesByRepo, tabsByWorktree: saved.tabsByWorktree })
  restored.getState().hydrateTabsSession(saved)
  expect(desktopChosenTabId(restored.getState(), WT)).toBe(picked.id)
  restored.setState({
    unifiedTabsByWorktree: { [WT]: present },
    tabsByWorktree: { [WT]: terminals }
  })
  restored.getState().reconcileWorktreeTabModel(WT)
  expect(shown(restored.getState()).tabId).toBe(picked.id)
})
