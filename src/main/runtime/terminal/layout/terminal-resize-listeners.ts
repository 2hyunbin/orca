import type { TerminalLayoutContext } from './terminal-layout-context'

import { addListenerToMap } from '../../orca-runtime-core'
import { notifyRuntimeListeners } from '../../runtime-async-boundaries'

export function subscribeToTerminalResize(
  ctx: TerminalLayoutContext,
  ptyId: string,
  listener: (event: {
    cols: number
    rows: number
    displayMode: string
    reason: string
    seq?: number
  }) => void
): () => void {
  return addListenerToMap(ctx.state.resizeListeners, ptyId, listener)
}

export function notifyTerminalResize(
  ctx: TerminalLayoutContext,
  ptyId: string,
  event: { cols: number; rows: number; displayMode: string; reason: string; seq?: number }
): void {
  const listeners = ctx.state.resizeListeners.get(ptyId)
  if (!listeners) {
    return
  }
  notifyRuntimeListeners(listeners, (listener) => listener(event), 'pty-resize')
}
