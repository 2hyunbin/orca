import { expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionSnapshotTab
} from '../../shared/runtime-types'
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { store, TEST_WORKTREE_ID: WT } = await import('./orca-runtime-test-fixtures.spec')

it.each([
  { only: false, pinned: false, retire: true },
  { only: true, pinned: false, retire: true },
  { only: false, pinned: true, retire: true },
  { only: false, pinned: true, retire: false }
])(
  'preserves current headless placement and pin partitions ($only/$pinned/$retire)',
  async ({ only, pinned, retire }) => {
    const runtime = new OrcaRuntimeService(store)
    const chat = (id: string): RuntimeMobileSessionSnapshotTab => ({
      type: 'agent-session',
      id,
      sessionId: id,
      agent: 'codex',
      title: id,
      isActive: false,
      isPinned: pinned && ['A', 'C', 'B'].includes(id)
    })
    const source = only ? ['C'] : pinned ? ['A', 'C', 'B', 'U'] : ['A', 'C', 'B']
    const initial: RuntimeMobileSessionTabsSnapshot = {
      worktree: WT,
      publicationEpoch: 'headless:test',
      snapshotVersion: 1,
      activeGroupId: 'R',
      activeTabId: 'D',
      activeTabType: 'agent-session',
      tabs: [...source, 'D'].map(chat),
      tabGroups: [
        { id: 'L', activeTabId: 'C', tabOrder: source },
        { id: 'R', activeTabId: 'D', tabOrder: ['D'] }
      ]
    }
    runtime.syncWindowGraph(0, { tabs: [], leaves: [], mobileSessionTabs: [initial] })
    runtime.setPtyController({
      spawn: vi.fn(async () => {
        if (retire) {
          expect(runtime.retireStructuredAgentSessionTabFromSnapshot('C')).toBe(true)
        }
        await runtime.publishStructuredAgentSessionTab({
          workspaceId: WT,
          sessionId: 'concurrent',
          agent: 'codex',
          activate: false
        })
        return { id: 'pty-placement', incarnationId: '45454545-4545-4545-8545-454545454545' }
      }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const created = await runtime.createMobileSessionTerminal(`id:${WT}`, {
      afterTabId: 'C',
      targetGroupId: 'L',
      command: 'codex resume conversation',
      activate: false
    })
    const result = await runtime.listMobileSessionTabs(`id:${WT}`)
    expect(result.tabs.some((tab) => tab.id === 'C')).toBe(!retire)
    expect(
      result.tabs.some((tab) => tab.type === 'agent-session' && tab.sessionId === 'concurrent')
    ).toBe(true)
    if (!only) {
      expect(result.tabGroups?.find((group) => group.id === 'L')?.tabOrder).toEqual(
        pinned
          ? ['A', ...(!retire ? ['C'] : []), 'B', created.tab.parentTabId, 'U']
          : ['A', created.tab.parentTabId, 'B']
      )
      expect(result.tabGroups?.find((group) => group.id === 'R')?.tabOrder).toContain('D')
    } else {
      expect(
        result.tabGroups?.some((group) => group.tabOrder.includes(created.tab.parentTabId))
      ).toBe(true)
    }
    const refreshed = await runtime.listMobileSessionTabs(`id:${WT}`)
    expect(refreshed.tabGroups).toEqual(result.tabGroups)
  }
)
