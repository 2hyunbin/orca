import { useEffect, useMemo, useState } from 'react'
import {
  AGENT_SESSION_AGENTS_METHOD,
  decodeAgentSessionAgentsResult
} from '../../../src/shared/agent-session-registered-agents'
import type { RpcClient } from '../transport/rpc-client'
import { callAgentSession } from './mobile-structured-agent-session-rpc'

/** A delivery choice needs a host that both queues and can inject into this agent's turn. */
export function useMobileStructuredSendChoice(args: {
  client: RpcClient | null
  agent: string | null
  enabled: boolean
}): boolean {
  const { client, agent, enabled } = args
  const generation = client?.getGeneration?.() ?? 0
  const request = useMemo(() => ({ client, enabled, generation }), [client, enabled, generation])
  const [support, setSupport] = useState<{
    request: typeof request
    agents: readonly string[]
  } | null>(null)
  useEffect(() => {
    if (!client || !enabled) {
      return
    }
    let stale = false
    void callAgentSession<unknown>(client, AGENT_SESSION_AGENTS_METHOD, {})
      .then((result) => {
        if (!stale) {
          setSupport({
            request,
            agents: (decodeAgentSessionAgentsResult(result) ?? [])
              .filter((row) => row.capabilities.steering === 'inject')
              .map((row) => row.agent)
          })
        }
      })
      .catch(() => {
        if (!stale) {
          setSupport(null)
        }
      })
    return () => {
      stale = true
    }
  }, [client, enabled, request])
  return enabled && support?.request === request && agent !== null && support.agents.includes(agent)
}
