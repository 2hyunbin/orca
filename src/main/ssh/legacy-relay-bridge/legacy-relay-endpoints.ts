/**
 * The relays an older Orca left listening for this target on a POSIX host.
 * COMPAT(legacy-relay-bridge): remove after 2026-11-15.
 *
 * Read-only: lists sockets, reads each daemon's own argv and `.version`, and never starts, stops
 * or removes anything.
 */
import type { SshConnection } from '../ssh-connection'
import { shellEscape } from '../ssh-connection-utils'
import { RELAY_REMOTE_DIR } from '../relay-protocol'
import { SHORT_RELAY_SOCKET_DIR_PREFIX } from '../relay-socket-path-limit'
import { execCommand } from '../ssh-relay-deploy-helpers'
import { readRelayDaemonRuntimes } from '../ssh-relay-endpoint-runtime'
import { relayBridgeConnectCommand } from '../ssh-relay-endpoint-pty-count'
import { relaySocketNameForInstanceId } from '../ssh-relay-instance-id'
import { readRemoteHomeCommand } from '../ssh-remote-commands'
import { resolveRemoteNodePath } from '../ssh-remote-node-resolution'
import { detectRemoteHostPlatform } from '../ssh-remote-platform-detection'
import {
  isWindowsRemoteHost,
  normalizeRemoteHome,
  validateRemoteHome,
  type RemoteHostPlatform
} from '../ssh-remote-platform'

const MAX_ENDPOINTS = 32

export type LegacyRelayEndpoint = {
  sockPath: string
  /** The relay's own `relay.js --connect`; null when its socket names no version directory. */
  connectCommand: string | null
  nodePath: string | null
}

export type LegacyRelayEndpointListing =
  | { kind: 'listed'; host: RemoteHostPlatform; endpoints: LegacyRelayEndpoint[] }
  /** Windows relays are named pipes the bridge never reaches; 1.4.224 did not bridge them either. */
  | { kind: 'unsupported' }
  | { kind: 'unverifiable' }

export function legacyRelayEndpointListCommand(remoteHome: string, sockName: string): string {
  return [
    `base=${shellEscape(`${remoteHome}/${RELAY_REMOTE_DIR}`)}`,
    `short_base="${SHORT_RELAY_SOCKET_DIR_PREFIX}$(id -u 2>/dev/null)"`,
    `for sock in "$base"/relay-*/${shellEscape(sockName)} "$short_base"/relay-*/${shellEscape(sockName)}; do`,
    '  [ -S "$sock" ] && printf \'%s\\n\' "$sock"',
    'done',
    'true'
  ].join('\n')
}

export async function listLegacyRelayEndpoints(
  conn: SshConnection,
  targetId: string,
  signal?: AbortSignal
): Promise<LegacyRelayEndpointListing> {
  try {
    const host = await detectRemoteHostPlatform(conn, { signal })
    if (!host) {
      return { kind: 'unverifiable' }
    }
    if (isWindowsRemoteHost(host)) {
      return { kind: 'unsupported' }
    }
    const remoteHome = normalizeRemoteHome(
      await execCommand(conn, readRemoteHomeCommand(host), { signal, wrapCommand: true }),
      host
    )
    if (!validateRemoteHome(remoteHome, host)) {
      return { kind: 'unverifiable' }
    }
    const listing = await execCommand(
      conn,
      legacyRelayEndpointListCommand(remoteHome, relaySocketNameForInstanceId(targetId)),
      { signal, wrapCommand: true }
    )
    const sockets = listing
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('/'))
    if (sockets.length > MAX_ENDPOINTS) {
      return { kind: 'unverifiable' }
    }
    if (sockets.length === 0) {
      return { kind: 'listed', host, endpoints: [] }
    }
    // Each relay is driven with the runtime it runs on; a daemon that is gone with any Node here.
    const runtimes = await readRelayDaemonRuntimes(conn, signal)
    let fallback: Promise<string | null> | undefined
    const endpoints: LegacyRelayEndpoint[] = []
    for (const sockPath of sockets) {
      const nodePath =
        runtimes.get(sockPath) ??
        (await (fallback ??= resolveRemoteNodePath(conn, host, { signal }).catch(() => null)))
      endpoints.push({
        sockPath,
        nodePath,
        connectCommand: nodePath ? relayBridgeConnectCommand(nodePath, sockPath) : null
      })
    }
    return { kind: 'listed', host, endpoints }
  } catch {
    return { kind: 'unverifiable' }
  }
}

/** The build id the relay's handshake answers with, read from its own version directory. */
export async function readLegacyRelayBuildId(
  conn: SshConnection,
  sockPath: string,
  signal?: AbortSignal
): Promise<string> {
  const dir = sockPath.slice(0, sockPath.lastIndexOf('/'))
  return (
    await execCommand(conn, `cat ${shellEscape(`${dir}/.version`)}`, { signal, wrapCommand: true })
  ).trim()
}
