import { describe, expect, it } from 'vitest'
import {
  normalizeTerminalPasteLineEndings,
  sanitizeBracketedPasteText,
  wrapTerminalBracketedPasteText
} from './terminal-bracketed-paste-text'

describe('large terminal paste transformations', () => {
  it.each([-1, 0, 1])('keeps CRLF together around a transformation boundary (%i)', (delta) => {
    const prefix = '\n'.repeat(64 * 1024 - 1 + delta)
    const suffix = '\r\n\r\r\n\n\rfinal\r'
    expect(normalizeTerminalPasteLineEndings(`${prefix}${suffix}`)).toBe(
      `${'\r'.repeat(prefix.length)}\r\r\r\r\rfinal\r`
    )
  })

  it('preserves a CRLF before the first transformation and an unchanged prefix', () => {
    const prefix = 'unchanged 😀\ud800\udfff'.repeat(5_000)
    const suffix = '\r\n'.repeat(100_000)
    expect(normalizeTerminalPasteLineEndings(`${prefix}${suffix}`)).toBe(
      `${prefix}${'\r'.repeat(100_000)}`
    )
  })

  it.each([-1, 0, 1])('preserves UTF-16 units around a transformation boundary (%i)', (delta) => {
    const prefix = '\x1b'.repeat(64 * 1024 - 1 + delta)
    const suffix = '😀\ud800x\udfff\x1b[201~final'
    expect(sanitizeBracketedPasteText(`${prefix}${suffix}`)).toBe(
      `${'␛'.repeat(prefix.length)}😀\ud800x\udfff␛[201~final`
    )
  })

  it('frames every transformed byte and neutralizes embedded paste terminators', () => {
    const line = '\x1b[201~😀\ud800x\udfff\r\n'
    expect(wrapTerminalBracketedPasteText(line.repeat(20_000))).toBe(
      `\x1b[200~${'␛[201~😀\ud800x\udfff\r'.repeat(20_000)}\x1b[201~`
    )
  })

  it('preserves large sparse and unchanged text', () => {
    const text = 'plain 😀\ud800'.repeat(20_000)
    expect(sanitizeBracketedPasteText(text)).toBe(text)
    expect(normalizeTerminalPasteLineEndings(text)).toBe(text)
    expect(wrapTerminalBracketedPasteText(`${text}\r\n\x1b[201~`)).toBe(
      `\x1b[200~${text}\r␛[201~\x1b[201~`
    )
  })
})
