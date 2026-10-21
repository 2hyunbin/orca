// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalDocumentScope } from './document-scope'
import { startMessageBridge, stopMessageBridge } from './message-bridge'
import { startTerminalDocument } from './create-terminal-document'
import { TERMINAL_DOCUMENT_MARKUP } from '../terminal-webview-html/document-markup'

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
  return { fail, finish, loaded, postToHost, scope }
}

describe('the terminal waits for its bundled glyphs', () => {
  it('withholds readiness until the font can paint the first terminal snapshot', async () => {
    const fonts = pendingFonts()
    startMessageBridge(fonts.scope)
    expect(fonts.postToHost).not.toHaveBeenCalled()
    fonts.finish()
    await fonts.loaded
    expect(fonts.postToHost).toHaveBeenCalledWith({ type: 'web-ready', cellBox: null })
    stopMessageBridge(fonts.scope)
  })

  it('still starts the terminal if font decoding fails', async () => {
    const fonts = pendingFonts()
    startMessageBridge(fonts.scope)
    fonts.fail()
    await fonts.loaded.catch(() => {})
    expect(fonts.postToHost).toHaveBeenCalledWith({ type: 'web-ready', cellBox: null })
    stopMessageBridge(fonts.scope)
  })

  it('unwinds the document and reports an error if deferred startup fails', async () => {
    const fonts = pendingFonts()
    document.body.innerHTML = TERMINAL_DOCUMENT_MARKUP
    fonts.scope.postToHost = (message) => {
      if (message.type === 'web-ready') {
        throw new Error('readiness transport failed')
      }
      fonts.postToHost(message)
    }
    const removeTransport = vi.fn()
    fonts.scope.installHostTransport = () => removeTransport
    startTerminalDocument(fonts.scope)
    fonts.finish()
    await fonts.loaded
    await Promise.resolve()
    expect(removeTransport).toHaveBeenCalledOnce()
    expect(fonts.scope.framesStopped).toBe(true)
    expect(fonts.postToHost).toHaveBeenCalledWith({
      type: 'error',
      fatal: true,
      message: expect.stringContaining('readiness transport failed')
    })
  })

  it('does not revive a document stopped during the font load', async () => {
    const fonts = pendingFonts()
    startMessageBridge(fonts.scope)
    stopMessageBridge(fonts.scope)
    fonts.finish()
    await fonts.loaded
    expect(fonts.postToHost).not.toHaveBeenCalled()
  })
})
