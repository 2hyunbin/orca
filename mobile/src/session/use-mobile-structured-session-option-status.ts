import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { structuralValuesEqual } from '../../../src/shared/structural-value-equality'
import type { AgentSessionStatusSummary } from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import { mobileStructuredSessionStatusFeed } from './mobile-structured-session-status-feed'

const noSubscription = (): (() => void) => () => {}

type OptionStatus = {
  stamp: string
  selection: AgentSessionStatusSummary['optionSelection']
}

const EMPTY_OPTION_STATUS: OptionStatus = { stamp: '', selection: undefined }

/** A live selection from a capable host, with the legacy stamp for older hosts. */
export function useMobileStructuredSessionOptionStatus(args: {
  client: RpcClient | null
  sessionId: string | null
  enabled: boolean
}): OptionStatus {
  const { client, sessionId, enabled } = args
  const feed = enabled && client && sessionId ? mobileStructuredSessionStatusFeed(client) : null
  const subscribe = useCallback(
    (listener: () => void) => (feed ? feed.subscribe(listener) : noSubscription()),
    [feed]
  )
  const readStatus = useMemo(() => {
    let previous = EMPTY_OPTION_STATUS
    return (): OptionStatus => {
      const summary = feed && sessionId ? feed.getSnapshot().get(sessionId) : undefined
      const stamp = `${summary?.model ?? ''}|${summary?.permissionMode ?? ''}`
      const selection = structuralValuesEqual(previous.selection, summary?.optionSelection)
        ? previous.selection
        : summary?.optionSelection
      if (previous.stamp !== stamp || previous.selection !== selection) {
        previous = { stamp, selection }
      }
      return previous
    }
  }, [feed, sessionId])
  return useSyncExternalStore(subscribe, readStatus, () => EMPTY_OPTION_STATUS)
}
