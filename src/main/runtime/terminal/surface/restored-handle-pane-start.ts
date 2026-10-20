// Layout-owner builds: a CLI or orchestration send, wait or read on a handle whose pane main holds
// with no terminal yet (a saved pane not started since restore) starts it through main's one
// starter, then acts on the started terminal.
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { OrcaRuntimeWithGetTerminalInteractiveWait } from '../wait/terminal-interactive-wait'
import { startedMainTerminalSurfaces } from './main-terminal-surfaces'

export abstract class OrcaRuntimeWithRestoredHandlePaneStart extends OrcaRuntimeWithGetTerminalInteractiveWait {
  /**
   * The handle to act on: the caller's, or, while the saved pane it names has just been started
   * here and main's layout has not yet bound it, the started terminal's own handle. The caller's
   * handle adopts the terminal when the binding lands (adoptFirstPtyForLeafHandle).
   */
  async startRestoredHandlePane(
    handle: string,
    bounds: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<string> {
    if (!ORCA_LAYOUT_OWNER_IS_MAIN || this.getLivePtyForHandle(handle)) {
      return handle
    }
    const { leaf } = this.getLiveLeafForHandle(handle)
    if (leaf.ptyId || !startedMainTerminalSurfaces(this)?.ownsWorkspace(leaf.worktreeId)) {
      return handle
    }
    const ptyId = await withinCallerBounds(
      this.ensureRestoredPaneStarted({
        worktreeId: leaf.worktreeId,
        tabId: leaf.tabId,
        leafId: leaf.leafId
      }),
      bounds
    )
    const pty = ptyId === null ? undefined : this.ptysById.get(ptyId)
    if (!pty) {
      throw new Error('terminal_not_found')
    }
    return this.issuePtyHandle(pty)
  }
}

/** The start, or the caller's abort or deadline first; the shared start itself runs on. */
function withinCallerBounds<T>(
  start: Promise<T>,
  { signal, timeoutMs }: { signal?: AbortSignal; timeoutMs?: number }
): Promise<T> {
  if (!signal && !(timeoutMs && timeoutMs > 0)) {
    return start
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new Error('request_aborted'))
    const timer =
      timeoutMs && timeoutMs > 0 ? setTimeout(() => reject(new Error('timeout')), timeoutMs) : null
    if (signal?.aborted) {
      abort()
    }
    signal?.addEventListener('abort', abort, { once: true })
    start.then(resolve, reject).finally(() => {
      if (timer) {
        clearTimeout(timer)
      }
      signal?.removeEventListener('abort', abort)
    })
  })
}
