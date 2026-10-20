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
import { useAppStore } from '@/store'
import { createNewTerminalTab } from '@/components/terminal/terminal-tab-create'

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
}
const chat = { type: 'agent-session', id: 'chat-1', sessionId: 's-1', agent: 'claude' } as const
const chatArrives = {
  worktree: WT,
  publicationEpoch: 'structured:epoch-1',
  snapshotVersion: 1,
  activeTabId: chat.id,
  activeTabType: 'agent-session',
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
  it.each([false, true])(
    'opens on its late agent chat across a reload, unless Setup was clicked: %s',
    (clickedSetup) => {
      const store = createTestStore()
      store.setState({ worktreesByRepo, activeWorktreeId: OTHER, activeTabId: 'other-terminal' })
      const setup = store.getState().createTab(WT, undefined, undefined, {
        activate: false,
        recordInteraction: false
      })
      if (clickedSetup) {
        // A click on the Setup already shown is still this window's choice.
        store.getState().recordDesktopTabChoice(WT)
        store.getState().activateTab(setup.id, { worktreeId: WT })
      }

      // Saved and reloaded while only Setup exists; then the chat arrives.
      const before = reloaded(buildWorkspaceSessionPayload(store.getState()))
      const projected = projectLocalStructuredSessionTabs(chatArrives)
      const options = {
        contentScope: 'agent-session',
        preserveLocalLayout: true,
        terminalPtyMode: 'local'
      } as const
      const after = {
        ...before,
        ...applyWebSessionTabsSnapshot(before, projected, 'local', 1, options)
      }
      const chatTab = after.unifiedTabsByWorktree[WT]!.find(
        (tab) => tab.entityId === chat.sessionId
      )
      const expected = clickedSetup
        ? { tabId: setup.id, type: 'terminal' }
        : { tabId: chatTab?.id, type: 'agent-session' }
      expect(shown(after)).toEqual(expected)
      expect([after.activeWorktreeId, after.activeTabId]).toEqual([OTHER, 'other-terminal'])

      // A second save and reload, and the layout-owner build's frames, keep it derived.
      const resaved = buildWorkspaceSessionPayload(after)
      expect(shown(reloaded(resaved))).toEqual(expected)
      expect(shownByFrames(resaved, after)).toBe(expected.tabId)

      // A terminal the user opens is a choice too: a restart reopens on it, as on main.
      const repo = {
        id: REPO_ID,
        path: '/workspace',
        displayName: 'repo',
        badgeColor: '',
        addedAt: 0
      }
      // Data only: the reloaded state's actions write to its own test store.
      const data = Object.entries(after).filter(([, value]) => typeof value !== 'function')
      useAppStore.setState({ ...Object.fromEntries(data), repos: [repo] })
      createNewTerminalTab(WT)
      const opened = useAppStore.getState().tabsByWorktree[WT]!.at(-1)!.id
      expect(shown(reloaded(buildWorkspaceSessionPayload(useAppStore.getState())))).toEqual({
        tabId: opened,
        type: 'terminal'
      })
    }
  )
})
