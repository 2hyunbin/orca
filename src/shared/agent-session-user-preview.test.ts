import { describe, expect, it } from 'vitest'
import { nativeChatUserMessagePreview } from './agent-session-conversation-outline'

describe('complete user-message previews', () => {
  it.each([0, 1, 2, 3])('collapses whitespace runs spanning a window with offset %i', (offset) => {
    const prefix = 'a '.repeat(256)
    const text = `${prefix}${'b'.repeat(65_534 + offset)}\r\n\t\u00a0${' c'.repeat(40_000)}\r\nend\n`
    expect(nativeChatUserMessagePreview([{ type: 'text', text }])).toEqual({
      text: text.replace(/\s+/g, ' ').trim(),
      imageCount: 0
    })
  })

  it('preserves Unicode, lone surrogates, images, and all text beyond the rail cap', () => {
    const whitespace = '\t\v\f\r\n \u00a0\u1680\u2000\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
    const text = `${whitespace}${`a${whitespace}😀\ud800x\udfff`.repeat(10_000)}tail${whitespace}`
    expect(
      nativeChatUserMessagePreview([
        { type: 'image-ref', path: '/image.png' },
        { type: 'text', text }
      ])
    ).toEqual({ text: text.replace(/\s+/g, ' ').trim(), imageCount: 1 })
  })

  it('collapses a whitespace run spanning several complete windows to one space', () => {
    const prefix = 'a '.repeat(40_000)
    const text = `${prefix}${'\r\n\t'.repeat(70_000)}end`
    expect(nativeChatUserMessagePreview([{ type: 'text', text }]).text).toBe(`${prefix}end`)
  })

  it.each([' '.repeat(140_000), 'a'.repeat(140_000), `${'a'.repeat(70_000)}\r\nend`])(
    'preserves large blank, plain, and sparse messages',
    (text) => {
      expect(nativeChatUserMessagePreview([{ type: 'text', text }]).text).toBe(
        text.replace(/\s+/g, ' ').trim()
      )
    }
  )
})
