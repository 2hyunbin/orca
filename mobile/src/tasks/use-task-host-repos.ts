import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import {
  reachableServerClients,
  relaysToServers
} from '../transport/execution-host-scoped-rpc-client'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { useRelayHosts } from '../worktree/relay-hosts-feed'
import { withServerHosts } from '../worktree/server-workspaces'
import { useServerRepos } from '../worktree/use-server-repos'
import type { RepoSummary } from './mobile-tasks-provider-detail-types'
import { routeTaskRepoCalls } from './task-repo-host-routing'
import type { HostRepoListResource } from './use-host-repo-list'

const NO_LABELS: ReadonlyMap<ExecutionHostId, string> = new Map()

/**
 * The Tasks screen's repos across the desktop and its servers, as the desktop's task page lists
 * them: the desktop's list settles on its own, and each server's joins as it answers.
 */
export function useTaskHostRepos(args: {
  desktopClient: RpcClient | null
  connState: ConnectionState
  hostCapabilities: readonly string[]
  desktopRepoList: HostRepoListResource<RepoSummary>
}) {
  const { desktopClient, connState, hostCapabilities, desktopRepoList } = args
  const relays = desktopClient !== null && relaysToServers(desktopClient, hostCapabilities)
  const servers = useRelayHosts(relays ? desktopClient : null)
  const serverClients = useMemo(
    () => reachableServerClients(desktopClient, hostCapabilities, servers ?? []),
    [desktopClient, hostCapabilities, servers]
  )
  const serverLabelById = useMemo(
    () => withServerHosts(NO_LABELS, servers ?? [], (host) => host.label),
    [servers]
  )
  const [serverListGeneration, setServerListGeneration] = useState(0)
  const serverRepos = useServerRepos<RepoSummary>(
    serverClients,
    connState === 'connected',
    serverListGeneration
  )
  const serverRepoList = useMemo(() => [...serverRepos.values()].flat(), [serverRepos])
  const desktopRepos = desktopRepoList.state.repos
  const repos = useMemo(
    () => (serverRepoList.length === 0 ? desktopRepos : [...desktopRepos, ...serverRepoList]),
    [desktopRepos, serverRepoList]
  )

  // Why a ref: a call can follow the list's arrival before React commits it.
  const serverReposRef = useRef(serverRepoList)
  useLayoutEffect(() => {
    serverReposRef.current = serverRepoList
  }, [serverRepoList])
  const { current: currentDesktopRepos, ensureLoaded, reload } = desktopRepoList
  const client = useMemo(
    () =>
      desktopClient &&
      routeTaskRepoCalls(desktopClient, () => [
        ...currentDesktopRepos(),
        ...serverReposRef.current
      ]),
    [currentDesktopRepos, desktopClient]
  )

  // A new identity once a server's repos join, so a load keyed on it re-runs with them.
  const repoListEnsureLoaded = useCallback(
    async (): Promise<RepoSummary[]> => [...(await ensureLoaded()), ...serverRepoList],
    [ensureLoaded, serverRepoList]
  )
  const repoListReload = useCallback(async (): Promise<RepoSummary[]> => {
    setServerListGeneration((generation) => generation + 1)
    return [...(await reload()), ...serverRepoList]
  }, [reload, serverRepoList])

  return { client, repos, repoListEnsureLoaded, repoListReload, serverLabelById }
}
