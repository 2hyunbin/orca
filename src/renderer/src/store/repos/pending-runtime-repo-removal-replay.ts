import { toast } from 'sonner'
import type { RuntimeHostStatusSnapshot } from '../../../../shared/runtime-host-status'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'
import { readIpcErrorMessage } from '@/lib/ipc-error'
import { ERROR_TOAST_DURATION } from './repo-state'
import {
  listPendingRuntimeRepoRemovals,
  replayPendingRuntimeRepoRemovals
} from './pending-runtime-repo-removals'

const readyEnvironments = new Set<string>()

/** Replays owed removals once per verified, ready connection, not on every snapshot. */
export function replayPendingRuntimeRepoRemovalsOnReady(snapshot: RuntimeHostStatusSnapshot): void {
  const { environmentId } = snapshot
  const ready =
    snapshot.retired !== true &&
    snapshot.transport === 'ready' &&
    snapshot.verification === 'verified'
  if (!ready) {
    readyEnvironments.delete(environmentId)
    return
  }
  // Marked only once there is work, so records seeded or queued after the first ready snapshot still replay.
  if (
    readyEnvironments.has(environmentId) ||
    listPendingRuntimeRepoRemovals(environmentId).length === 0
  ) {
    return
  }
  readyEnvironments.add(environmentId)
  const target = { kind: 'environment', environmentId } as const
  void replayPendingRuntimeRepoRemovals(
    environmentId,
    (repoId) => callRuntimeRpc(target, 'repo.rm', { repo: repoId }, { timeoutMs: 15_000 }),
    (_repoId, error) => {
      toast.error(
        translate(
          'auto.store.slices.repos.pendingRemovalRefused',
          'The server kept a project you removed while it was offline'
        ),
        {
          description: readIpcErrorMessage(error) ?? String(error),
          duration: ERROR_TOAST_DURATION
        }
      )
    }
  ).catch((error) => console.warn('[repos] replaying pending project removals failed', error))
}

export function resetPendingRuntimeRepoRemovalReplayForTests(): void {
  readyEnvironments.clear()
}
