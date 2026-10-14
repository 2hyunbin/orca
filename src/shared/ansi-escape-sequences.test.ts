import { describe, expect, it, vi } from 'vitest'
import { stripAnsiEscapeSequences } from './ansi-escape-sequences'
import { sanitizeCheckJobLogExcerpt } from './check-job-log-excerpt'

const strings = [
  ['DCS', '\x1bP', '\x90'],
  ['APC', '\x1b_', '\x9f'],
  ['PM', '\x1b^', '\x9e'],
  ['SOS', '\x1bX', '\x98']
] as const
const st = ['\x1b\\', '\x9c']

describe('ordered linear ANSI stripping', () => {
  it.each(['\x1b]', '\x9d'])('removes OSC introduced by %j with all terminators', (intro) => {
    for (const end of ['\x07', ...st]) {
      expect(stripAnsiEscapeSequences(`界\t${intro}title\nbody${end}😀\r\n`)).toBe('界\t😀\r\n')
      expect(stripAnsiEscapeSequences(`a${intro}${end}b`)).toBe('ab')
    }
  })
  it.each(strings)('removes %s with ST, treating BEL as payload', (_family, seven, eight) => {
    for (const intro of [seven, eight]) {
      for (const end of st) {
        expect(stripAnsiEscapeSequences(`a${intro}left\x07right\n${end}b`)).toBe('ab')
        expect(stripAnsiEscapeSequences(`a${intro}${end}b`)).toBe('ab')
      }
      expect(stripAnsiEscapeSequences(`${intro}body\x07`)).toBe(
        intro === seven ? 'body\x07' : `${intro}body\x07`
      )
    }
  })
  it.each(['\x1b[', '\x9b'])('removes valid CSI %j and preserves failed bytes', (intro) => {
    for (const body of ['31m', '?25l', '1;2H', '0K', '1 q']) {
      expect(stripAnsiEscapeSequences(`a${intro}${body}b`)).toBe('ab')
    }
    const leftover = intro === '\x1b[' ? '' : intro
    for (const body of ['', '31', '1 ', '12\x00m', '1\x18m']) {
      expect(stripAnsiEscapeSequences(`${intro}${body}`)).toBe(`${leftover}${body}`)
    }
  })
  it('preserves unrelated controls and incomplete generic escapes', () => {
    expect(stripAnsiEscapeSequences('a\x1b(Bb\x1bc\x1b\\c')).toBe('abc')
    expect(stripAnsiEscapeSequences('\x00\x01\x18\x1a\x7f\x9c\t\r\n\x1b ')).toBe(
      '\x00\x01\x18\x1a\x7f\x9c\t\r\n\x1b '
    )
  })
  it.each([
    ['\x1b]a\x1b\\KEEP\x1b]b\x07', 'KEEP'],
    ['\x1bPleft\x07right\x1b\\KEEP', 'KEEP'],
    ['\x1bPleft\x1b]hidden\x1b\\right\x1b\\KEEP', 'KEEP'],
    ['\x1b]body\x1b\x1b\\KEEP', 'KEEP'],
    ['\x1b]body\x1b', 'body\x1b'],
    ['\x1b]a\x07KEEP\x1b]b\x1b\\TAIL', 'KEEPTAIL'],
    ['\x1b]a\x07\x1b\\\x1b]b\x1b\\KEEP', 'KEEP'],
    ['\x1b]a\x9cKEEP\x1bPb\x1b\\TAIL', 'KEEPTAIL'],
    ['\x1b]a\x1b]b\x1bPc', 'abc']
  ])('pins terminator cache edges for %j', (input, expected) => {
    expect(stripAnsiEscapeSequences(input)).toBe(expected)
  })
  it('sanitizes a partial ST without completing it', () => {
    expect(sanitizeCheckJobLogExcerpt('\x1b]body\x1b')).toBe('body')
  })
  it.each(['\x1b]', '\x9d', ...strings.flatMap(([, seven, eight]) => [seven, eight])])(
    'preserves printable fragments of unfinished %j',
    (intro) => {
      const expected = intro.length === 2 ? 'body' : `${intro}body`
      expect(stripAnsiEscapeSequences(`${intro}body`)).toBe(expected)
      expect(stripAnsiEscapeSequences(`\x1b[31mOK\x1b[0m${intro}body`)).toBe(`OK${expected}`)
      expect(stripAnsiEscapeSequences(`${intro}body\x1b`)).toBe(`${expected}\x1b`)
    }
  )
  it.each([16 * 1024, 32 * 1024])('bounds actual scanner reads with cached EOF at %i', (size) => {
    const input = '\x1b]a\x1b]b\x1bPc'.repeat(Math.ceil(size / 9)).slice(0, size)
    const read = String.prototype.charCodeAt
    let reads = 0
    const spy = vi.spyOn(String.prototype, 'charCodeAt').mockImplementation(function (
      this: string,
      index: number
    ) {
      reads++
      return read.call(this, index)
    })
    try {
      stripAnsiEscapeSequences(input)
      expect(reads).toBeGreaterThan(size)
      expect(reads).toBeLessThanOrEqual(12 * size + 64)
    } finally {
      spy.mockRestore()
      spy.mockClear()
    }
  })
})
