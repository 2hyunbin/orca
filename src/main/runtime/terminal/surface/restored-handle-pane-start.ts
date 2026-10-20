// Layout-owner builds: a CLI or orchestration send, wait or read on a handle whose pane main holds
// with no terminal yet (a saved pane not started since restore) starts it through main's one
// starter, then acts on the started terminal.
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { OrcaRuntimeWithGetTerminalInteractiveWait } from '../wait/terminal-interactive-wait'
import { startedMainTerminalSurfaces } from './main-terminal-surfaces'
import { MOBILE_TERMINAL_SURFACE_TIMEOUT_MS } from '../../orca-runtime-core'

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
      { ...bounds, startTimeoutMs: MOBILE_TERMINAL_SURFACE_TIMEOUT_MS }
    )
    const pty = ptyId === null ? undefined : this.ptysById.get(ptyId)
    if (!pty) {
      throw new Error('terminal_not_found')
    }
    return this.issuePtyHandle(pty)
  }
}

/**
 * The start, or the first of: the caller's abort, the caller's deadline (`timeout`), or the start's
 * own cap (`runtime_timeout`, the pending-terminal create bound), so no caller waits on a start
 * forever. The shared start itself runs on.
 */
function withinCallerBounds<T>(
  start: Promise<T>,
  {
    signal,
    timeoutMs,
    startTimeoutMs
  }: { signal?: AbortSignal; timeoutMs?: number; startTimeoutMs: number }
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(new Error('request_aborted'))
  }
  const callerFirst = !!timeoutMs && timeoutMs > 0 && timeoutMs <= startTimeoutMs
  return new Promise<T>((resolve, reject) => {
    const settle = (finish: () => void): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      finish()
    }
    const abort = (): void => settle(() => reject(new Error('request_aborted')))
    const timer = setTimeout(
      () => settle(() => reject(new Error(callerFirst ? 'timeout' : 'runtime_timeout'))),
      callerFirst ? timeoutMs : startTimeoutMs
    )
    signal?.addEventListener('abort', abort, { once: true })
    start.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error))
    )
  })
}
