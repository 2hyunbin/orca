import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileViewPatch, WorkspaceViewSettings } from '../worktree/workspace-view-settings'
import { hostViewSettingsWrite } from './host-screen-operations'
import { readHostMethodReply, setCollapsedWrite } from './host-sidebar-feed-operations'
import {
  PENDING_VIEW_CHANGE_STALE_MS,
  isSettledByDesktop,
  type PendingViewChange
} from './host-view-pending-changes'

const REFUSED_NOTE = 'The desktop did not take that change.'

export type HostPendingViewChanges = {
  pending: readonly PendingViewChange[]
  /** Some change has waited past PENDING_VIEW_CHANGE_STALE_MS. */
  stale: boolean
  sendView: (patch: MobileViewPatch, payload: WorkspaceViewSettings) => void
  /** `wholeList` writes the change the old way, for a host without ui.setCollapsed. */
  sendCollapse: (key: string, collapsed: boolean, wholeList: () => void) => void
  /** The changes still waiting once the desktop's values are read; after a reconnect each is resent. */
  reconcile: (ui: WorkspaceViewSettings, options: { reconnected: boolean }) => PendingViewChange[]
}

/**
 * The phone's own option changes until the desktop answers each: acknowledged, refused (the
 * change is undone and a note says so), or already holding the asked value.
 */
export function useHostPendingViewChanges(args: {
  client: RpcClient | null
  setActionError: (message: string) => void
  /** Re-reads the desktop's values after a refusal, which undoes the change locally. */
  resync: () => void
}): HostPendingViewChanges {
  const { client, setActionError, resync } = args
  const pendingRef = useRef<PendingViewChange[]>([])
  const [pending, setPending] = useState<readonly PendingViewChange[]>([])
  const [stale, setStale] = useState(false)
  const seqRef = useRef(0)
  // A fresh writer per screen: its seq restarts at zero.
  const [writer] = useState(
    () => `phone-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  )

  const update = useCallback((next: PendingViewChange[]) => {
    pendingRef.current = next
    setPending(next)
  }, [])
  const settle = useCallback(
    (opId: number) => update(pendingRef.current.filter((change) => change.opId !== opId)),
    [update]
  )
  const refuse = useCallback(
    (opId: number) => {
      settle(opId)
      setActionError(REFUSED_NOTE)
      resync()
    },
    [settle, setActionError, resync]
  )

  const send = useCallback(
    (change: PendingViewChange, wholeList?: () => void) => {
      if (!client) {
        return
      }
      if (change.kind === 'view') {
        hostViewSettingsWrite.request(client, change.payload).then(
          (reply) => (reply.ok ? settle(change.opId) : refuse(change.opId)),
          // No answer is not a refusal: the value stays, waiting.
          () => {}
        )
        return
      }
      setCollapsedWrite
        .request(client, {
          key: change.key,
          collapsed: change.collapsed,
          opId: { writer, seq: change.opId }
        })
        .then(
          (reply) => {
            if (readHostMethodReply(reply, setCollapsedWrite.interpret).kind === 'unavailable') {
              settle(change.opId)
              wholeList?.()
            } else if (reply.ok) {
              settle(change.opId)
            } else {
              refuse(change.opId)
            }
          },
          () => {}
        )
    },
    [client, settle, refuse, writer]
  )

  const add = useCallback(
    (change: PendingViewChange, wholeList?: () => void) => {
      update([...pendingRef.current, change])
      send(change, wholeList)
    },
    [update, send]
  )
  const nextOp = (): { opId: number; sentAt: number } => {
    seqRef.current += 1
    return { opId: seqRef.current, sentAt: Date.now() }
  }

  const sendView = useCallback(
    (patch: MobileViewPatch, payload: WorkspaceViewSettings) =>
      add({ ...nextOp(), kind: 'view', patch, payload }),
    [add]
  )
  const sendCollapse = useCallback(
    (key: string, collapsed: boolean, wholeList: () => void) =>
      add({ ...nextOp(), kind: 'collapse', key, collapsed }, wholeList),
    [add]
  )
  const reconcile = useCallback(
    (ui: WorkspaceViewSettings, { reconnected }: { reconnected: boolean }) => {
      const waiting = pendingRef.current.filter((change) => !isSettledByDesktop(change, ui))
      if (waiting.length !== pendingRef.current.length) {
        update(waiting)
      }
      if (reconnected) {
        // Each sets a desired value, so sending one again is safe.
        waiting.forEach((change) => send(change))
      }
      return waiting
    },
    [update, send]
  )

  useEffect(() => {
    const oldest = pending[0]
    if (!oldest) {
      setStale(false)
      return
    }
    const wait = oldest.sentAt + PENDING_VIEW_CHANGE_STALE_MS - Date.now()
    if (wait <= 0) {
      setStale(true)
      return
    }
    setStale(false)
    const timer = setTimeout(() => setStale(true), wait)
    return () => clearTimeout(timer)
  }, [pending])

  return { pending, stale, sendView, sendCollapse, reconcile }
}
