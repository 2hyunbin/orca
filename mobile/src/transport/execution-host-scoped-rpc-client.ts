import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY } from '../../../src/shared/mobile-desktop-relay-contract'
import type { RpcClient } from './rpc-client'

const scopedViews = new WeakMap<RpcClient, Map<ExecutionHostId, RpcClient>>()

/**
 * Whether this phone can reach the desktop's servers: the desktop relays, over a transport that
 * keeps `executionHost` (a shell older than it would strip it and run the call on the desktop).
 */
export function relaysToServers(client: RpcClient, hostCapabilities: readonly string[]): boolean {
  return (
    hostCapabilities.includes(MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY) &&
    (client.carriesExecutionHost?.() ?? true)
  )
}

/**
 * The `executionHost` a route into a workspace carries: none for the desktop's own (local, SSH),
 * the server for a reachable one, and null for one this phone cannot reach, which must not open.
 */
export function workspaceRouteExecutionHost(
  client: RpcClient | null,
  hostCapabilities: readonly string[],
  executionHost: ExecutionHostId | undefined
): ExecutionHostId | undefined | null {
  if (!executionHost?.startsWith('runtime:')) {
    return undefined
  }
  return client && relaysToServers(client, hostCapabilities) ? executionHost : null
}

/**
 * A view of the paired desktop's client that runs each call on the host `hostOf` names for its
 * params, and on the desktop when it names none. The view owns no connection, so `close` leaves
 * the shared client open.
 */
export function routeRpcClientCalls(
  client: RpcClient,
  hostOf: (params: unknown) => ExecutionHostId | undefined
): RpcClient {
  return {
    sendRequest: (method, params, options) => {
      const executionHost = hostOf(params)
      return client.sendRequest(
        method,
        params,
        executionHost ? { ...options, executionHost } : options
      )
    },
    subscribe: (method, params, onData, options) => {
      const executionHost = hostOf(params)
      return client.subscribe(
        method,
        params,
        onData,
        executionHost ? { ...options, executionHost } : options
      )
    },
    updateTerminalSubscriptionViewport: (terminal, viewport) =>
      client.updateTerminalSubscriptionViewport(terminal, viewport),
    getState: () => client.getState(),
    getReconnectAttempt: () => client.getReconnectAttempt(),
    getLastConnectedAt: () => client.getLastConnectedAt(),
    getLastInboundAt: client.getLastInboundAt && (() => client.getLastInboundAt?.() ?? null),
    getGeneration: client.getGeneration && (() => client.getGeneration?.() ?? 0),
    carriesExecutionHost: () => client.carriesExecutionHost?.() ?? true,
    onStateChange: (listener) => client.onStateChange(listener),
    notifyForeground: (reason) => client.notifyForeground(reason),
    close: () => {}
  }
}

/**
 * The paired desktop's client with every call run on `executionHost`, mirroring the desktop's
 * `callRuntimeRpc(target, …)`. One view per (client, host), so screens comparing client identity
 * keep working.
 */
export function scopeRpcClientToExecutionHost(
  client: RpcClient,
  executionHost: ExecutionHostId
): RpcClient {
  let views = scopedViews.get(client)
  if (!views) {
    views = new Map()
    scopedViews.set(client, views)
  }
  const existing = views.get(executionHost)
  if (existing) {
    return existing
  }
  const view = routeRpcClientCalls(client, () => executionHost)
  views.set(executionHost, view)
  return view
}

/**
 * The client for calls about a workspace on `executionHost`: the desktop's own for its workspaces,
 * a scoped view for a reachable server, and null for a server not reachable yet — never the
 * desktop client for a server's workspace, which would run the call on the wrong computer.
 */
export function rpcClientForExecutionHost(
  client: RpcClient,
  hostCapabilities: readonly string[],
  executionHost: ExecutionHostId | undefined
): RpcClient | null {
  const routeHost = workspaceRouteExecutionHost(client, hostCapabilities, executionHost)
  if (routeHost === undefined) {
    return client
  }
  return routeHost && scopeRpcClientToExecutionHost(client, routeHost)
}

/** A scoped client for each of the desktop's servers this phone can reach now, by host. */
export function reachableServerClients(
  client: RpcClient | null,
  hostCapabilities: readonly string[],
  hosts: readonly { hostId: `runtime:${string}`; relay: string }[]
): ReadonlyMap<ExecutionHostId, RpcClient> {
  const clients = new Map<ExecutionHostId, RpcClient>()
  if (!client || !relaysToServers(client, hostCapabilities)) {
    return clients
  }
  for (const host of hosts) {
    if (host.relay === 'ready') {
      clients.set(host.hostId, scopeRpcClientToExecutionHost(client, host.hostId))
    }
  }
  return clients
}
