import { subscribeAcceptedWebSessionTerminalHandle } from '../../runtime/web-session-terminal-handle-events'
import { sameWhenBothKnown } from './remote-terminal-host-exit-record'

/** Fires once the host publishes a provably different live process for an exit-settled pane. */
export function watchHostRebindAfterExit(
  args: {
    environmentId: string
    worktreeId: string
    hostTabId: string
    leafId: string
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
