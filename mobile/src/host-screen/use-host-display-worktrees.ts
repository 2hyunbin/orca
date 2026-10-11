import { useMemo } from 'react'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { useHostDescriptor } from '../transport/host-descriptor-store'
import type { ConnectionState } from '../transport/types'
import { serverHostHealth } from '../worktree/server-workspaces'
import { filterVisibleHostRows } from '../worktree/visible-host-rows'
import {
  applyWorktreeHostContextLabels,
  type HostLabelSources
} from '../worktree/worktree-host-context-labels'
import { applyWorktreeRowDisplayState } from '../worktree/worktree-host-row-identity'
import type { HostScreenState } from './use-host-screen-state'

/** What names each host on this screen: the row badges and the new-workspace run targets. */
export function useHostLabelSources(
  hostId: string | undefined,
  state: HostScreenState
): HostLabelSources {
  const { serverWorkspaces } = state
  // Why: a server's label and health come with its rows, alongside the desktop's SSH ones.
  const hostLabelById = useMemo(
    () => withServerHosts(state.hostLabelById, serverWorkspaces.hosts, (host) => host.label),
    [state.hostLabelById, serverWorkspaces.hosts]
  )
  const hostHealthById = useMemo(
    () => withServerHosts(state.hostHealthById, serverWorkspaces.hosts, serverHostHealth),
    [state.hostHealthById, serverWorkspaces.hosts]
  )
  const descriptorPlatform = useHostDescriptor(hostId)?.platform ?? null
  // Why: metadata reads the platform only for a mixed desktop catalog; server rows mix it too.
  const hostPlatform = state.hostPlatform ?? descriptorPlatform
  return useMemo(
    () => ({
      repoHostIdByRepoId: state.repoHostIdByRepoId,
      hostLabelById,
      hostPlatform,
      hostHealthById
    }),
    [state.repoHostIdByRepoId, hostLabelById, hostPlatform, hostHealthById]
  )
}

/** The rows the host list renders: the live or last-known catalog with display state and host badges. */
export function useHostDisplayWorktrees(
  connState: ConnectionState,
  state: HostScreenState,
  labels: HostLabelSources
) {
  return useMemo(() => {
    // Why: live `worktrees` is authoritative only while connected; under the amber
    // mount default, connecting/handshaking must keep the pre-reconnect list too.
    const base = connState === 'connected' ? state.worktrees : state.lastKnownWorktrees
    const rows = filterVisibleHostRows(
      [...base, ...state.serverWorkspaces.worktrees],
      state.visibleHostIds,
      state.repoHostIdByRepoId
    )
    return applyWorktreeHostContextLabels(
      applyWorktreeRowDisplayState(rows, state.sleptIds, state.optimisticActiveWorktreeIdentity),
      labels
    )
  }, [
    connState,
    state.worktrees,
    state.lastKnownWorktrees,
    state.serverWorkspaces.worktrees,
    state.visibleHostIds,
    state.sleptIds,
    state.optimisticActiveWorktreeIdentity,
    state.repoHostIdByRepoId,
    labels
  ])
}

function withServerHosts<Value>(
  desktop: ReadonlyMap<ExecutionHostId, Value>,
  hosts: HostScreenState['serverWorkspaces']['hosts'],
  read: (host: HostScreenState['serverWorkspaces']['hosts'][number]) => Value
): ReadonlyMap<ExecutionHostId, Value> {
  if (hosts.length === 0) {
    return desktop
  }
  const merged = new Map(desktop)
  for (const host of hosts) {
    merged.set(host.hostId, read(host))
  }
  return merged
}
