import {
  captureWebSessionIntentOwner,
  matchesWebSessionIntentOwner
} from '@/runtime/web-runtime-session-environment'
import { useAppStore } from '@/store'
import { revealTerminalPane } from '@/lib/reveal-terminal-pane'
import { requestActiveTerminalPaneClose } from '../terminal-pane/request-active-terminal-pane-close'
import { subscribeToPtyExit } from '../terminal-pane/pty-dispatcher'
import {
  captureTerminalSurfaceIdentity,
  isRetainedTerminalSurfaceIdentity
} from '../../../../shared/terminal-tab-close'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { HeldTerminalTarget } from './native-chat-held-terminal'

export const HOLDING_TERMINAL_EXIT_TIMEOUT_MS = 10_000

/** Renderer removal precedes process exit; only the captured host lifetime releases the continuation. */
export async function closeHoldingTerminalThenContinue(
  target: HeldTerminalTarget,
  continuation: () => void | Promise<void>
): Promise<boolean> {
  const capture = () =>
    captureTerminalSurfaceIdentity(
      useAppStore.getState(),
      target.worktreeId,
      target.tabId,
      target.leafId
    )
  const original = capture()
  if (!original || !revealTerminalPane(target)) {
    return false
  }
  const host = parseExecutionHostId(target.executionHostId)
  const paired = host?.kind === 'runtime'
  const owner = paired ? captureWebSessionIntentOwner(host.environmentId) : null
  const isCurrent = () => {
    const current = capture()
    return (
      current !== null &&
      isRetainedTerminalSurfaceIdentity(original, current) &&
      (!owner || matchesWebSessionIntentOwner(owner))
    )
  }
  const continued = await new Promise<boolean>((resolve) => {
    let settled = false,
      closed = false,
      exited = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopExit = () => {}
    const finish = (proceed: boolean) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      stopExit()
      resolve(proceed)
    }
    if (!paired && original.ptyId) {
      const watch: Parameters<typeof subscribeToPtyExit>[1] = (_code, context) => {
        if (!original.incarnationId || context.incarnationId !== original.incarnationId) {
          stopExit = subscribeToPtyExit(original.ptyId ?? '', watch)
          return
        }
        exited = true
        if (closed) {
          finish(true)
        }
      }
      stopExit = subscribeToPtyExit(original.ptyId, watch)
    }
    // The normal reveal path also waits a frame for the mounted pane's listener.
    requestAnimationFrame(() => {
      if (!isCurrent()) {
        finish(false)
        return
      }
      const accepted = requestActiveTerminalPaneClose(target.tabId, {
        leafId: target.leafId,
        isCurrent,
        onCancel: () => finish(false),
        onHostClosed: (success) => {
          if (paired) {
            finish(success)
          }
        },
        onClosed: () => {
          if (closed || settled) {
            return
          }
          closed = true
          if (!paired && (exited || !original.ptyId)) {
            finish(true)
            return
          }
          if (!paired) {
            timer = setTimeout(() => finish(true), HOLDING_TERMINAL_EXIT_TIMEOUT_MS)
          }
        }
      })
      if (!accepted) {
        finish(false)
      }
    })
  })
  if (continued) {
    await continuation()
  }
  return continued
}
