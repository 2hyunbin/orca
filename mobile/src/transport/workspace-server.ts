import { useEffect, useState } from 'react'
import { AppState } from 'react-native'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { ExecutionHostHealth } from '../../../src/shared/execution-host-health'
import { serverHostHealth } from '../worktree/server-workspaces'
import { relayHostsListRead } from '../worktree/server-workspace-operations'
import {
  scopeRpcClientToExecutionHost,
  workspaceRouteExecutionHost
} from './execution-host-scoped-rpc-client'
import { useHostStatusGates, type HostStatusGates } from './host-status-gates'
import type { RpcClient } from './rpc-client'
import type { ConnectionState } from './types'

/**
 * Where a workspace runs, as seen through the paired desktop. Whether a server is reachable stays
 * the desktop's answer; what it supports is the server's own status, read through the desktop.
 * `server` is null for the desktop's own workspaces (local, SSH, folder).
 */
export function useWorkspaceServer(args: {
  client: RpcClient | null
  connState: ConnectionState
  desktopCapabilities: readonly string[]
  executionHost: ExecutionHostId | undefined
}): {
  routeHost: ExecutionHostId | undefined | null
  server: { client: RpcClient | null; gates: HostStatusGates } | null
} {
  const { client, connState, desktopCapabilities, executionHost } = args
  const routeHost = workspaceRouteExecutionHost(client, desktopCapabilities, executionHost)
  const serverClient = client && routeHost ? scopeRpcClientToExecutionHost(client, routeHost) : null
  // No hostId: the desktop's recorded version and descriptor must not take the server's.
  const gates = useHostStatusGates({ hostId: undefined, client: serverClient, connState })
  return { routeHost, server: routeHost === undefined ? null : { client: serverClient, gates } }
}

// The host list's poll cadence, so a workspace screen and its row agree within one tick.
const SERVER_HEALTH_POLL_MS = 3000

/**
 * The connection state a server workspace's screens see: the desktop's, unless the desktop reports
 * that server down. Desktop-owned workspaces (`routeHost` absent) keep the desktop's state untouched.
 */
export function useWorkspaceServerConnState(args: {
  client: RpcClient | null
  connState: ConnectionState
  routeHost: ExecutionHostId | undefined | null
}): ConnectionState {
  const { client, connState, routeHost } = args
  const [reported, setReported] = useState<{
    client: RpcClient
    routeHost: ExecutionHostId
    health: ExecutionHostHealth
  } | null>(null)

  useEffect(() => {
    if (!client || connState !== 'connected' || !routeHost) {
      return
    }
    let stopped = false
    const read = async (): Promise<void> => {
      if (AppState.currentState !== 'active') {
        return
      }
      try {
        const listed = relayHostsListRead.interpret(await relayHostsListRead.request(client))
        if (stopped || !listed.accepted) {
          return
        }
        const host = listed.value.find((entry) => entry.hostId === routeHost)
        // A server the desktop no longer lists cannot be reached through it.
        setReported({ client, routeHost, health: host ? serverHostHealth(host) : 'disconnected' })
      } catch {
        // Keeps the last answer; the next poll retries.
      }
    }
    void read()
    const timer = setInterval(() => void read(), SERVER_HEALTH_POLL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [client, connState, routeHost])

  // Why: keyed by client and server so a reused route never shows another server's answer.
  if (
    connState !== 'connected' ||
    reported?.client !== client ||
    reported.routeHost !== routeHost
  ) {
    return connState
  }
  switch (reported.health) {
    case 'local':
    case 'available':
      return 'connected'
    case 'connecting':
      return 'connecting'
    case 'blocked':
    case 'disconnected':
    case 'error':
      return 'disconnected'
  }
}
