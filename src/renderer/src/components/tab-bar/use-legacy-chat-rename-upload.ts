import { useEffect, useMemo } from 'react'
import { useAppStore } from '@/store'
import type { Tab } from '../../../../shared/tab-types'
import { structuredAgentSessionTargetForTab } from '@/runtime/structured-agent-session-owner'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/structured-agent-session-host-capability'
import { uploadLegacyStructuredChatRename } from '@/runtime/structured-chat-rename'
import { STRUCTURED_AGENT_SESSION_RENAME_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'

// One upload per tab and name per window run: a refused or failed one is not retried in a loop.
const uploaded = new Set<string>()

/** A chat tab still carrying a rename saved before names lived on the host hands it to the host
 *  once the host proves it can save it; until then the tab keeps showing it. */
export function useLegacyChatRenameUpload(tab: Tab | undefined): void {
  const alias = tab?.contentType === 'agent-session' ? (tab.customLabel ?? null) : null
  const executionHostId = tab?.executionHostId
  const worktreeId = tab?.worktreeId
  const target = useMemo(
    () =>
      alias !== null && worktreeId !== undefined
        ? structuredAgentSessionTargetForTab(useAppStore.getState(), {
            worktreeId,
            executionHostId
          })
        : null,
    [alias, executionHostId, worktreeId]
  )
  const support = useStructuredAgentSessionHostCapabilityState(
    target,
    STRUCTURED_AGENT_SESSION_RENAME_RUNTIME_CAPABILITY
  )
  const tabId = tab?.id
  useEffect(() => {
    if (support !== 'supported' || alias === null || tabId === undefined) {
      return
    }
    const key = `${tabId}\u0000${alias}`
    const current = Object.values(useAppStore.getState().unifiedTabsByWorktree)
      .flat()
      .find((entry) => entry.id === tabId)
    if (uploaded.has(key) || !current) {
      return
    }
    uploaded.add(key)
    void uploadLegacyStructuredChatRename(useAppStore.getState, current, alias)
  }, [alias, support, tabId])
}
