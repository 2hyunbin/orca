import { HIDDEN_WINDOW_FRAME_PUMP_STOP_CHANNEL } from '../../shared/hidden-window-frame-pump'

type FramePumpWindow = {
  once(event: 'show', listener: () => void): unknown
  webContents: {
    isDestroyed(): boolean
    on(event: 'did-finish-load', listener: () => void): unknown
    send(channel: string): void
  }
}

/** The preload pumps from birth; stop it on first show and after any later reload restarts it. */
export function stopHiddenWindowFramePumpOnShow(window: FramePumpWindow): void {
  let shown = false
  const stop = (): void => {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(HIDDEN_WINDOW_FRAME_PUMP_STOP_CHANNEL)
    }
  }
  window.once('show', () => {
    shown = true
    stop()
  })
  window.webContents.on('did-finish-load', () => {
    if (shown) {
      stop()
    }
  })
}
