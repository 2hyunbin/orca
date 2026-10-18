import type { AppState } from '@/store/types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { ClientWorkspaceView } from '../../../shared/rpc-contract/client-workspace-view-params'
import { DESKTOP_AWAY_SECONDS } from '../../../shared/desktop-away-threshold'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { tryRuntimeTargetForWorktreeOwner } from '@/store/slices/worktrees/listing/worktree-owner-target'
import { onScreenHostId } from '@/store/slices/workspace-attention/workspace-unread-flag'
import { presenceRemainingMs } from './agent-auto-ack-presence'
import type { AutoAckTabTarget } from './agent-auto-ack-targets'

// Renewed once the host's copy of presence has half the away threshold left.
const RENEW_PRESENCE_MS = (DESKTOP_AWAY_SECONDS * 1000) / 2

type HostView = {
  target: RuntimeClientTarget
  workspaceIds: string[]
  tabIds: string[]
  signature: string
}
type SentView = { target: RuntimeClientTarget; signature: string; presentUntil: number }

export type ClientWorkspaceViewReporter = {
  /** The scan's screen: its workspaces and tabs, empty while the window is hidden or unfocused. */
  update: (
    state: AppState,
    workspaceIds: readonly string[],
    targets: readonly AutoAckTabTarget[]
  ) => void
  /** Trusted input arrived. */
  renewPresence: () => void
}

function targetKey(target: RuntimeClientTarget): string {
  return target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
}

/**
 * Tells each host that owns an on-screen workspace what this window shows of it, so the host
 * raises no unread flag there. A host whose workspaces left the screen is sent an empty view.
 */
export function createClientWorkspaceViewReporter(
  send: (target: RuntimeClientTarget, view: ClientWorkspaceView) => Promise<unknown> = (
    target,
    view
  ) => callRuntimeRpc(target, 'sidebarInputs.reportView', view)
): ClientWorkspaceViewReporter {
  let views = new Map<string, HostView>()
  const sent = new Map<string, SentView>()

  const flush = (): void => {
    const now = Date.now()
    const presentForMs = presenceRemainingMs()
    const presentUntil = presentForMs === null ? Number.POSITIVE_INFINITY : now + presentForMs
    for (const key of new Set([...sent.keys(), ...views.keys()])) {
      const view = views.get(key)
      const previous = sent.get(key)
      const target = view?.target ?? previous?.target
      const changed = previous?.signature !== view?.signature
      // Infinity minus Infinity is NaN, so an untracked presence is never renewed.
      const renews =
        view !== undefined &&
        previous !== undefined &&
        presentUntil - previous.presentUntil >= RENEW_PRESENCE_MS
      if (!target || (!changed && !renews)) {
        continue
      }
      if (view) {
        sent.set(key, { target, signature: view.signature, presentUntil })
      } else {
        sent.delete(key)
      }
      // An older host has no reportView; it keeps no view to be wrong about.
      void send(target, {
        workspaceIds: view?.workspaceIds ?? [],
        tabIds: view?.tabIds ?? [],
        presentForMs
      }).catch(() => {})
    }
  }

  return {
    update: (state, workspaceIds, targets) => {
      const next = new Map<string, HostView>()
      const hostView = (workspaceId: string): HostView | null => {
        const target = tryRuntimeTargetForWorktreeOwner(
          state,
          workspaceId,
          onScreenHostId(state, workspaceId) ?? undefined
        )
        if (!target) {
          return null
        }
        const key = targetKey(target)
        let view = next.get(key)
        if (!view) {
          view = { target, workspaceIds: [], tabIds: [], signature: '' }
          next.set(key, view)
        }
        return view
      }
      for (const workspaceId of workspaceIds) {
        hostView(workspaceId)?.workspaceIds.push(workspaceId)
      }
      for (const target of targets) {
        if (target.worktreeId !== null) {
          hostView(target.worktreeId)?.tabIds.push(target.tabId)
        }
      }
      for (const view of next.values()) {
        view.signature = JSON.stringify([view.workspaceIds, view.tabIds])
      }
      views = next
      flush()
    },
    renewPresence: flush
  }
}
