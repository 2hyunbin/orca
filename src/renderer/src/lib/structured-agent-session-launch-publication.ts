import { readNativeChatNewDraft, retireNativeChatNewDraft } from '@/components/native-chat/native-chat-new-draft'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { deleteStructuredAgentLaunchRecord } from './structured-agent-session-launch-persistence'
import { resolveHostSessionGroupIdForWebSessionTab, setHostSessionTabIdMapping } from '@/runtime/web-session-tabs-sync/tracking-mappings'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import { structuredAgentSessionFocusOwner, structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import {
  getPersistedStructuredAgentLaunchRecord,
  getStructuredLaunchStateBySessionId,
  hasStructuredAgentSessionLaunchCancellationTombstone,
  notifyStructuredLaunchListeners
} from './structured-agent-session-launch-registry'

function confirmStructuredLaunchFirstMessagePublication(
  worktreeId: string,
  sessionId: string
): void {
  // Store teardown imports publication bookkeeping; recovery may read the store after it exists.
  void import('./structured-agent-session-launch-publication-confirmation')
    .then((confirmation) =>
      confirmation.confirmStructuredLaunchFirstMessagePublication(worktreeId, sessionId)
    )
    .catch((error: unknown) => {
      console.warn('[native-chat] confirming a published opening message failed', error)
    })
}

/** `executionHostId` published the chat; only the host its launch was sent to settles it. */
export function markStructuredAgentSessionLaunchPublished(
  worktreeId: string,
  sessionId: string,
  executionHostId: ExecutionHostId
): boolean {
  const draft = readNativeChatNewDraft(sessionId)
  if (draft?.owner.workspaceId === worktreeId && draft.owner.executionHostId === executionHostId) {
    const target = structuredAgentSessionTargetForHost(executionHostId)
    if (target) {
      const tabId = structuredAgentSessionTabId(sessionId)
      const mapping = { ...structuredAgentSessionFocusOwner(target), worktreeId, tabId }
      setHostSessionTabIdMapping(mapping, tabId, resolveHostSessionGroupIdForWebSessionTab(mapping) ?? undefined)
    }
    void retireNativeChatNewDraft(sessionId)
  }
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (!state) {
    const persisted = getPersistedStructuredAgentLaunchRecord(sessionId)
    if (persisted?.executionHostId !== executionHostId) {
      return false
    }
    if (persisted.firstMessage) {
      confirmStructuredLaunchFirstMessagePublication(worktreeId, sessionId)
      return false
    }
    deleteStructuredAgentLaunchRecord(sessionId)
    notifyStructuredLaunchListeners()
    return true
  }
  if (
    state.intent.worktreeId !== worktreeId ||
    state.cancelled ||
    state.intent.executionHostId !== executionHostId
  ) {
    return false
  }
  state.hostPublished = true
  notifyStructuredLaunchListeners()
  if (state.callers.outcome === 'published') {
    return true
  }
  // Still in flight: its own settlement publishes once the picks held during launch land.
  if (state.callers.outcome === 'pending') {
    return true
  }
  if (state.intent.params.firstMessage) {
    confirmStructuredLaunchFirstMessagePublication(worktreeId, sessionId)
    return false
  }
  state.callers.outcome = 'published'
  deleteStructuredAgentLaunchRecord(sessionId)
  state.callers.onSettled()
  notifyStructuredLaunchListeners()
  return true
}

/** Settles every launch a host's publication shows, from whichever mirror carried it. */
export function markStructuredAgentSessionLaunchesPublished(
  executionHostId: ExecutionHostId,
  published: Iterable<{ worktreeId: string; sessionId: string }>
): void {
  for (const { worktreeId, sessionId } of published) {
    if (!hasStructuredAgentSessionLaunchCancellationTombstone(worktreeId, sessionId)) {
      markStructuredAgentSessionLaunchPublished(worktreeId, sessionId, executionHostId)
    }
  }
}

/** The structured chats a host's snapshots show, keyed as launch bookkeeping reads them. */
export function publishedStructuredSessions(
  snapshots: readonly RuntimeMobileSessionTabsResult[]
): { worktreeId: string; sessionId: string }[] {
  return snapshots.flatMap((snapshot) =>
    snapshot.tabs.flatMap((tab) =>
      tab.type === 'agent-session'
        ? [{ worktreeId: snapshot.worktree, sessionId: tab.sessionId }]
        : []
    )
  )
}
