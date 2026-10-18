import type { AppState } from '@/store/types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { ClientWorkspaceView } from '../../../shared/rpc-contract/client-workspace-view-params'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { tryRuntimeTargetForWorktreeOwner } from '@/store/slices/worktrees/listing/worktree-owner-target'
import { onScreenHostId } from '@/store/slices/workspace-attention/workspace-unread-flag'
import { presenceRemainingMs, subscribeAutoAckPresenceSignals } from './agent-auto-ack-presence'
import type { AutoAckTabTarget } from './agent-auto-ack-targets'

// While the user is active, a host's copy of the view is resent this often: its presence trails the
// window's by at most this, and a host that lost the connection (and so the view) learns it again.
const REFRESH_MS = 10_000

type HostView = {
  target: RuntimeClientTarget
  workspaceIds: string[]
  tabIds: string[]
  signature: string
}
type SentView = { target: RuntimeClientTarget; signature: string; sentAt: number; present: boolean }

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
    const present = presentForMs !== 0
    for (const key of new Set([...sent.keys(), ...views.keys()])) {
      const view = views.get(key)
      const previous = sent.get(key)
      const target = view?.target ?? previous?.target
      const refreshes =
        view !== undefined &&
        previous !== undefined &&
        present &&
        (!previous.present || now - previous.sentAt >= REFRESH_MS)
      if (!target || (previous?.signature === view?.signature && !refreshes)) {
        continue
      }
      const entry = view && { target, signature: view.signature, sentAt: now, present }
      if (entry) {
        sent.set(key, entry)
      } else {
        sent.delete(key)
      }
      // An older host has no reportView. A failed send is forgotten, so the next flush retries it.
      void send(target, {
        workspaceIds: view?.workspaceIds ?? [],
        tabIds: view?.tabIds ?? [],
        presentForMs
      }).catch(() => {
        if (entry && sent.get(key) === entry) {
          sent.delete(key)
        }
      })
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

/** The scan's presence signals plus blur: a window still visible but behind another app shows nothing. */
export function subscribeViewReportPresenceSignals(
  onRescan: () => void,
  onInput: () => void
): () => void {
  const stop = subscribeAutoAckPresenceSignals(onRescan, onInput)
  window.addEventListener('blur', onRescan)
  return () => {
    stop()
    window.removeEventListener('blur', onRescan)
  }
}
