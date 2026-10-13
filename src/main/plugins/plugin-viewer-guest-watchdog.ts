import type { WebSource } from 'electron'

export const PLUGIN_VIEWER_HEARTBEAT_INTERVAL_MS = 250
export const PLUGIN_VIEWER_HEARTBEAT_DEADLINE_MS = 2_000
const VIEWER_HEARTBEAT_WORLD = 1_002

type RendererIdentity = {
  id: number
  isDestroyed(): boolean
  getOSProcessId(): number
}

export type PluginViewerGuestProcess = RendererIdentity & {
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: WebSource[]): Promise<unknown>
  forcefullyCrashRenderer(): void
  once(event: 'destroyed' | 'render-process-gone', callback: () => void): unknown
  removeListener(event: 'destroyed' | 'render-process-gone', callback: () => void): unknown
}

type WatchdogOptions = {
  getPeerContents(): readonly RendererIdentity[]
  isAuthorized?(): boolean
  canCrash?(): boolean
  probe?(worldId: number): Promise<unknown>
  recover?(): void
  onUnavailable(reason: 'unresponsive' | 'shared_process' | 'renderer_changed'): void
}

export function hasExclusivePluginViewerProcess(
  guest: RendererIdentity,
  peers: readonly RendererIdentity[]
): boolean {
  if (guest.isDestroyed()) {
    return false
  }
  const pid = guest.getOSProcessId()
  return (
    Number.isSafeInteger(pid) &&
    pid > 0 &&
    !peers.some(
      (peer) => peer.id !== guest.id && !peer.isDestroyed() && peer.getOSProcessId() === pid
    )
  )
}

/** Call on a host-owned bootstrap before admitting document bytes. */
export function startPluginViewerGuestWatchdog(
  guest: PluginViewerGuestProcess,
  options: WatchdogOptions
): { dispose(): void } {
  if (!hasExclusivePluginViewerProcess(guest, options.getPeerContents())) {
    throw new Error('plugin_viewer_shared_process')
  }
  const admittedPid = guest.getOSProcessId()
  let stopped = false
  let interval: ReturnType<typeof setTimeout> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined

  const dispose = (): void => {
    if (stopped) {
      return
    }
    stopped = true
    clearTimeout(interval)
    clearTimeout(deadline)
    guest.removeListener('destroyed', dispose)
    guest.removeListener('render-process-gone', dispose)
  }
  const unavailable = (reason: Parameters<WatchdogOptions['onUnavailable']>[0]): void => {
    dispose()
    options.onUnavailable(reason)
  }
  const pulse = (): void => {
    if (stopped || guest.isDestroyed()) {
      return dispose()
    }
    if (guest.getOSProcessId() !== admittedPid) {
      return unavailable('renderer_changed')
    }
    if (
      !hasExclusivePluginViewerProcess(guest, options.getPeerContents()) ||
      options.isAuthorized?.() === false
    ) {
      return unavailable('shared_process')
    }
    deadline = setTimeout(() => {
      if (stopped || guest.isDestroyed()) {
        return dispose()
      }
      if (guest.getOSProcessId() !== admittedPid) {
        return unavailable('renderer_changed')
      }
      if (
        !hasExclusivePluginViewerProcess(guest, options.getPeerContents()) ||
        options.isAuthorized?.() === false ||
        options.canCrash?.() === false
      ) {
        return unavailable('shared_process')
      }
      dispose()
      try {
        if (options.recover) {
          options.recover()
        } else {
          guest.forcefullyCrashRenderer()
        }
      } catch {
        return options.onUnavailable('renderer_changed')
      }
      options.onUnavailable('unresponsive')
    }, PLUGIN_VIEWER_HEARTBEAT_DEADLINE_MS)
    // The author world cannot forge this result; blocked guest execution cannot answer it.
    void Promise.resolve()
      .then(() =>
        options.probe
          ? options.probe(VIEWER_HEARTBEAT_WORLD)
          : guest.executeJavaScriptInIsolatedWorld(VIEWER_HEARTBEAT_WORLD, [{ code: 'true' }])
      )
      .then(
        (alive) => {
          if (stopped) {
            return
          }
          clearTimeout(deadline)
          if (alive !== true) {
            return unavailable('renderer_changed')
          }
          interval = setTimeout(pulse, PLUGIN_VIEWER_HEARTBEAT_INTERVAL_MS)
        },
        () => {
          if (!stopped) {
            unavailable('renderer_changed')
          }
        }
      )
  }
  guest.once('destroyed', dispose)
  guest.once('render-process-gone', dispose)
  pulse()
  return { dispose }
}
