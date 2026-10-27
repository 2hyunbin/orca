import { HIDDEN_WINDOW_FRAME_PUMP_STOP_CHANNEL } from '../../shared/hidden-window-frame-pump'

type FramePumpWindow = {
  once(event: 'show', listener: () => void): unknown
  webContents: { isDestroyed(): boolean; send(channel: string): void }
}

/** The preload pumps frames from birth; the first show ends it for good. */
export function stopHiddenWindowFramePumpOnShow(window: FramePumpWindow): void {
  window.once('show', () => {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(HIDDEN_WINDOW_FRAME_PUMP_STOP_CHANNEL)
    }
  })
}
