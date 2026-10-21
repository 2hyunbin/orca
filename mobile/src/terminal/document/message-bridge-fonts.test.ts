// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalDocumentScope } from './document-scope'
import { startMessageBridge, stopMessageBridge } from './message-bridge'

const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts')
afterEach(() => {
  if (originalFonts) {
    Object.defineProperty(document, 'fonts', originalFonts)
  } else {
    Reflect.deleteProperty(document, 'fonts')
  }
})

function pendingFonts() {
  let finish = () => {}
  let fail = () => {}
  const loaded = new Promise<FontFace[]>((resolve, reject) => {
    finish = () => resolve([])
    fail = () => reject(new Error('font unavailable'))
  })
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { check: () => false, load: () => loaded }
  })
  const postToHost = vi.fn()
  const scope = createTerminalDocumentScope({
    postToHost,
    hasEngine: () => true,
    start: () => ({ shown: false, textScale: 1 }),
    installHostTransport: () => () => {}
  })
  startMessageBridge(scope)
  return { fail, finish, loaded, postToHost, scope }
}

describe('the terminal waits for its bundled glyphs', () => {
  it('withholds readiness until the font can paint the first terminal snapshot', async () => {
    const fonts = pendingFonts()
    expect(fonts.postToHost).not.toHaveBeenCalled()
    fonts.finish()
    await fonts.loaded
    expect(fonts.postToHost).toHaveBeenCalledWith({ type: 'web-ready', cellBox: null })
    stopMessageBridge(fonts.scope)
  })

  it('still starts the terminal if font decoding fails', async () => {
    const fonts = pendingFonts()
    fonts.fail()
    await fonts.loaded.catch(() => {})
    expect(fonts.postToHost).toHaveBeenCalledWith({ type: 'web-ready', cellBox: null })
    stopMessageBridge(fonts.scope)
  })

  it('does not revive a document stopped during the font load', async () => {
    const fonts = pendingFonts()
    stopMessageBridge(fonts.scope)
    fonts.finish()
    await fonts.loaded
    expect(fonts.postToHost).not.toHaveBeenCalled()
  })
})
