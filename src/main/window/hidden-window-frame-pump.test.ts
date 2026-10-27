import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { HIDDEN_WINDOW_FRAME_PUMP_STOP_CHANNEL } from '../../shared/hidden-window-frame-pump'
import { stopHiddenWindowFramePumpOnShow } from './hidden-window-frame-pump'

function fakeWindow(destroyed = false) {
  const emitter = new EventEmitter()
  const send = vi.fn()
  const window = {
    once: (event: 'show', listener: () => void) => emitter.once(event, listener),
    webContents: { isDestroyed: () => destroyed, send }
  }
  return { window, emitter, send }
}

describe('stopHiddenWindowFramePumpOnShow', () => {
  it('tells the renderer to stop once, on the first show', () => {
    const { window, emitter, send } = fakeWindow()
    stopHiddenWindowFramePumpOnShow(window)

    emitter.emit('show')
    emitter.emit('show')

    expect(send).toHaveBeenCalledExactlyOnceWith(HIDDEN_WINDOW_FRAME_PUMP_STOP_CHANNEL)
  })

  it('sends nothing to destroyed contents', () => {
    const { window, emitter, send } = fakeWindow(true)
    stopHiddenWindowFramePumpOnShow(window)

    emitter.emit('show')

    expect(send).not.toHaveBeenCalled()
  })
})
