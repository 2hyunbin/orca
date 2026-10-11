import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import { structuredAgentSessionTabId } from '../../shared/structured-agent-session-projection'
import { OrcaRuntimeService } from './orca-runtime'

/**
 * The window never lists chats in its tab publications, and names them in its group order by its
 * own unified tab id, not the host's `agent-session:<id>`. So the host keeps every chat it still
 * holds after the window's tabs, in its own order, before and while one of them is closing.
 */

const WORKTREE = 'repo1::/tmp/worktree'

function publishWindowTabs(
  runtime: OrcaRuntimeService,
  snapshotVersion: number,
  tabOrder: string[]
): void {
  runtime.syncWindowGraph(1, {
    tabs: [],
    leaves: [],
    mobileSessionTabs: [
      {
        worktree: WORKTREE,
        publicationEpoch: 'renderer:1',
        snapshotVersion,
        activeGroupId: 'group-1',
        activeTabId: 't1::leaf',
        activeTabType: 'terminal',
        tabGroups: [{ id: 'group-1', activeTabId: 't1', tabOrder }],
        tabs: ['t1', 't2'].map((parentTabId) => ({
          type: 'terminal' as const,
          id: `${parentTabId}::leaf`,
          parentTabId,
          leafId: 'leaf',
          title: parentTabId,
          isActive: parentTabId === 't1'
        }))
      }
    ]
  })
}

function order(result: RuntimeMobileSessionTabsResult): { tabs: string[]; group: string[] } {
  return {
    tabs: result.tabs.map((tab) => tab.id),
    group: result.tabGroups?.[0]?.tabOrder ?? []
  }
}

describe('a chat the window stops listing while it closes', () => {
  it('keeps its place in the host list', async () => {
    const runtime = new OrcaRuntimeService()
    runtime.attachWindow(1)
    publishWindowTabs(runtime, 1, ['t1', 't2'])
    for (const sessionId of ['x', 'y', 'z']) {
      await runtime.publishStructuredAgentSessionTab({
        workspaceId: WORKTREE,
        sessionId,
        agent: 'codex',
        activate: false
      })
    }
    const windowChatId = (sessionId: string): string => structuredAgentSessionTabId(sessionId)
    publishWindowTabs(runtime, 2, [
      't1',
      windowChatId('x'),
      windowChatId('y'),
      windowChatId('z'),
      't2'
    ])
    const before = order(await runtime.listMobileSessionTabs(`id:${WORKTREE}`))

    // The window removed chat y at once; the host has not retired it yet.
    publishWindowTabs(runtime, 3, ['t1', windowChatId('x'), windowChatId('z'), 't2'])

    const during = order(await runtime.listMobileSessionTabs(`id:${WORKTREE}`))
    expect(before).toEqual({
      tabs: ['t1::leaf', 't2::leaf', 'agent-session:x', 'agent-session:y', 'agent-session:z'],
      group: ['t1', 't2', 'agent-session:x', 'agent-session:y', 'agent-session:z']
    })
    expect(during).toEqual(before)
  })
})
