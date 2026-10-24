import { subscribeAcceptedWebSessionTerminalHandle } from '../../runtime/web-session-terminal-handle-events'
import { sameWhenBothKnown } from './remote-terminal-host-exit-record'

/**
 * After a host-session pane settles on the host's exit record, watch the host's accepted snapshots
 * for a live process the host binds to the same pane. A restart can land its new process just after
 * the probe read the old one's exit, so the snapshot that publishes it must hand the pane back.
 * Only a ready handle that is provably a different process counts; the exited one republished, a
 * pending surface, or a handle without a distinguishing incarnation keeps waiting.
 */
export function watchHostRebindAfterExit(
  args: {
    environmentId: string
    worktreeId: string
    hostTabId: string
    leafId: string | null
    exitedHandle: string
    exitedIncarnationId: string | null
  },
  onRebound: (handle: string) => void
): () => void {
  let stopped = false
  const stop = subscribeAcceptedWebSessionTerminalHandle(args, (update) => {
    if (stopped) {
      return
    }
    if (!update.surfacePresent) {
      dispose()
      return
    }
    const next = update.terminalHandle
    if (
      !next ||
      (next === args.exitedHandle &&
        sameWhenBothKnown(update.incarnationId, args.exitedIncarnationId))
    ) {
      return
    }
    dispose()
    onRebound(next)
  })
  function dispose(): void {
    stopped = true
    stop()
  }
  return dispose
}
