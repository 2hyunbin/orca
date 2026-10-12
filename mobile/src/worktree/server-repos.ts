import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { nativeChatRepoListRead } from '../session/mobile-session-read-operations'
import {
  reachableServerClients,
  relaysToServers
} from '../transport/execution-host-scoped-rpc-client'
import type { RpcClient } from '../transport/rpc-client'
import { relayHostsFeed } from './relay-hosts-feed'

type ListedRepo = { connectionId?: string | null }

/** One host's repos, or null when it refused or failed to answer. */
export async function listHostRepos<Repo extends ListedRepo>(
  client: RpcClient
): Promise<Repo[] | null> {
  const listed = nativeChatRepoListRead.interpret(await nativeChatRepoListRead.request(client))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
  return listed.accepted ? (listed.value as Repo[]) : null
}

/**
 * A server's repos tagged with that server, as the desktop offers them. Its SSH repos are left
 * out: their connection is the server's, which the phone's SSH gate cannot read.
 */
export async function listServerRepos<Repo extends ListedRepo>(
  executionHostId: ExecutionHostId,
  client: RpcClient
): Promise<(Repo & { executionHostId: ExecutionHostId })[] | null> {
  const listed = await listHostRepos<Repo>(client).catch(() => null)
  return (
    listed?.filter((repo) => !repo.connectionId).map((repo) => ({ ...repo, executionHostId })) ??
    null
  )
}

/** Every reachable server's repos through the desktop; a server that does not answer lists none. */
export async function listReachableServerRepos<Repo extends ListedRepo>(
  client: RpcClient,
  hostCapabilities: readonly string[]
): Promise<(Repo & { executionHostId: ExecutionHostId })[]> {
  if (!relaysToServers(client, hostCapabilities)) {
    return []
  }
  const hosts = (await relayHostsFeed(client).read()) ?? []
  const servers = reachableServerClients(client, hostCapabilities, hosts)
  const listed = await Promise.all(
    [...servers].map(([host, serverClient]) => listServerRepos<Repo>(host, serverClient))
  )
  return listed.flatMap((repos) => repos ?? [])
}
