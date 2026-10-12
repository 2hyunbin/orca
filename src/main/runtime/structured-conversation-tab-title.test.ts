import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import { titleStructuredConversationTabs } from './structured-conversation-tab-title'

const snapshot: RuntimeMobileSessionTabsSnapshot = {
  worktree: 'workspace-1',
  publicationEpoch: 'epoch-1',
  snapshotVersion: 2,
  activeGroupId: null,
  activeTabId: 'agent-session:session-1',
  activeTabType: 'agent-session',
  tabs: [
    {
      type: 'agent-session',
      id: 'agent-session:session-1',
      sessionId: 'session-1',
      title: 'Claude Chat',
      agent: 'claude',
      isActive: true
    }
  ]
}

describe('structured conversation tab title', () => {
  it('projects only the title from the record at read time', () => {
    const projected = titleStructuredConversationTabs(snapshot, () => 'auth/login')
    expect(projected.tabs[0]).toMatchObject({ title: 'auth/login', sessionId: 'session-1' })
    expect(projected.snapshotVersion).toBe(snapshot.snapshotVersion)
    expect(titleStructuredConversationTabs(projected, () => null).tabs[0]).toMatchObject({
      title: 'Claude Chat'
    })
  })
})
