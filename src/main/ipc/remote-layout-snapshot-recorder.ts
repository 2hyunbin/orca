// The one writer of the display-only server layout snapshot (design 6.3, D3). It records the
// `session.tabs.subscribeAll` frames main already relays to the window, so no server receives a
// new request. Nothing reads the snapshot yet.

import type { RemoteLayoutSnapshot } from '../../shared/remote-layout-snapshot'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-session-contracts'

export type RemoteLayoutSnapshotStore = {
  getRemoteLayoutSnapshot(environmentId: string): RemoteLayoutSnapshot | undefined
  setRemoteLayoutSnapshot(environmentId: string, snapshot: RemoteLayoutSnapshot | null): void
}

type SessionTabsUpdate = RuntimeMobileSessionTabsResult & { type: 'updated'; removed?: true }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Checks the identity fields only; the rest is the server's published contract.
function isSessionTabsResult(value: unknown): value is RuntimeMobileSessionTabsResult {
  return isRecord(value) && typeof value.worktree === 'string' && Array.isArray(value.tabs)
}

function isSessionTabsUpdate(value: unknown): value is SessionTabsUpdate {
  return isSessionTabsResult(value) && 'type' in value && value.type === 'updated'
}

/** Called for every relayed stream frame; only the window's all-worktree tab stream is recorded. */
export function recordRemoteLayoutFrame(
  store: RemoteLayoutSnapshotStore,
  environmentId: string,
  method: string,
  response: RuntimeRpcResponse<unknown>
): void {
  if (method !== 'session.tabs.subscribeAll' || !response.ok) {
    return
  }
  const frame = response.result
  const recorded = {
    receivedAt: Date.now(),
    serverRuntimeId: response._meta.runtimeId,
    protocol: 'session-tabs' as const
  }
  if (
    isRecord(frame) &&
    frame.type === 'snapshots' &&
    Array.isArray(frame.snapshots) &&
    frame.snapshots.every(isSessionTabsResult)
  ) {
    // A census replaces the whole entry: a worktree missing from it is gone.
    const workspaces = Object.fromEntries(
      frame.snapshots.map((snapshot) => [snapshot.worktree, snapshot])
    )
    store.setRemoteLayoutSnapshot(environmentId, { ...recorded, workspaces })
    return
  }
  if (!isSessionTabsUpdate(frame)) {
    return
  }
  const { type: _type, removed, ...result } = frame
  const { [frame.worktree]: _previous, ...others } =
    store.getRemoteLayoutSnapshot(environmentId)?.workspaces ?? {}
  store.setRemoteLayoutSnapshot(environmentId, {
    ...recorded,
    workspaces: removed ? others : { ...others, [frame.worktree]: result }
  })
}

/** A removed server's snapshot goes with it. */
export function forgetRemoteLayoutSnapshot(
  store: RemoteLayoutSnapshotStore,
  environmentId: string
): void {
  store.setRemoteLayoutSnapshot(environmentId, null)
}
