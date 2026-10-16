import { describe, expect, it, vi } from 'vitest'
import { parseAnsiSegments, type AnsiSegment } from './ipynb-ansi'
import { interpretDrawnBlocks } from './ipynb-drawn-ansi'
import { drawnBlock } from './ipynb-output-tail'

describe('parseAnsiSegments', () => {
  it.each([
    ['\u001b]title\ntext', '\u0007'],
    ['\u009dtitle\ntext', '\u009c'],
    ['\u001bPpayload\ntext\u001b', '\\'],
    ['\u0090payload\ntext', '\u009c'],
    ['\u001b[3', '1mred\u001b[0m'],
    ['\u001b(', 'Btext'],
    ['\u001b]title\n\u001b[32mgreen', '\u0007'],
    ['\u001bPouter\u001b]inner\u0007\n', '\u001b\\'],
    ['\u001b\u001b]title\u0007', '[31mRED'],
    ['\u001b\u001bPpayload\u001b\\]title\u0007', 'ordinary']
  ])('keeps split control semantics and releases closed dependencies: %j', (a, b) => {
    const flatten = (runs: AnsiSegment[]) =>
      runs.flatMap((run) =>
        [...run.text].map((unit) => [unit, run.fg, run.bg, run.bold, run.italic, run.underline])
      )
    const first = drawnBlock(a)
    interpretDrawnBlocks([first])
    for (const suffix of ['', b.slice(0, -1), b, '\u001b[31m1%', '\u000720%']) {
      const actual = interpretDrawnBlocks([first, drawnBlock(suffix, 0)])
      expect(flatten(actual.flatMap((block) => block.segments))).toEqual(
        flatten(parseAnsiSegments(a + suffix))
      )
    }
    const second = drawnBlock(b)
    const closed = interpretDrawnBlocks([first, second, drawnBlock('\n1%', 0)])
    const next = interpretDrawnBlocks([first, second, drawnBlock('\n20%', 0)])
    expect(next[0]).toBe(closed[0])
  })

  it('returns plain text untouched', () => {
    expect(parseAnsiSegments('hello\nworld')).toEqual([{ text: 'hello\nworld' }])
  })

  it('does not scan plain accumulated output for SGR or stripping patterns', () => {
    const text = 'iteration α🐋\tvalue\n'.repeat(100_000)
    const matchAll = vi.spyOn(String.prototype, 'matchAll')
    const replace = vi.spyOn(String.prototype, 'replace')
    let segments: ReturnType<typeof parseAnsiSegments>
    let scans: number
    try {
      segments = parseAnsiSegments(text)
      scans = matchAll.mock.calls.length + replace.mock.calls.length
    } finally {
      matchAll.mockRestore()
      replace.mockRestore()
    }
    expect(segments).toEqual([{ text }])
    expect(scans).toBe(0)
    expect(parseAnsiSegments('')).toEqual([])
  })

  it.each([
    '\u001b]title\u0007',
    '\u001b]title\u001b\\',
    '\u009dtitle\u009c',
    '\u001bPpayload\u001b\\',
    '\u001b_payload\u001b\\',
    '\u001b^payload\u001b\\',
    '\u001bXpayload\u001b\\',
    '\u0090payload\u009c',
    '\u0098payload\u009c',
    '\u009epayload\u009c',
    '\u009fpayload\u009c',
    '\u009b31m',
    '\u001b[K',
    '\u001b(B'
  ])('preserves stripping for every supported introducer: %j', (sequence) => {
    expect(parseAnsiSegments(`before${sequence}after`)).toEqual([{ text: 'beforeafter' }])
  })

  it('preserves non-ANSI controls, unicode and incomplete escape semantics', () => {
    const text = '\u0000\u0007\u0008\t\n\r\u0085\u009c\u00a0α🐋\u2028\u2029'
    expect(parseAnsiSegments(text)).toEqual([{ text }])
    expect(parseAnsiSegments('before\u001b]unfinished')).toEqual([{ text: 'beforeunfinished' }])
    expect(parseAnsiSegments('before\u009dunfinished')).toEqual([
      { text: 'before\u009dunfinished' }
    ])
  })

  it('applies and resets 16-color and bold attributes', () => {
    expect(parseAnsiSegments('a\u001b[1;32mb\u001b[0mc\u001b[91md\u001b[39me')).toEqual([
      { text: 'a' },
      { text: 'b', bold: true, fg: 2 },
      { text: 'c' },
      { text: 'd', fg: 9 },
      { text: 'e', fg: undefined }
    ])
  })

  it('resolves 256-color and truecolor sequences', () => {
    expect(parseAnsiSegments('\u001b[38;5;241mx\u001b[38;5;4my\u001b[48;2;1;2;3mz')).toEqual([
      { text: 'x', fg: 'rgb(98, 98, 98)' },
      { text: 'y', fg: 4 },
      { text: 'z', fg: 4, bg: 'rgb(1, 2, 3)' }
    ])
  })

  it('drops non-SGR escape sequences from text', () => {
    expect(parseAnsiSegments('50%\u001b[K done')).toEqual([{ text: '50% done' }])
  })

  it('treats a bare reset as clearing every attribute', () => {
    expect(parseAnsiSegments('\u001b[4;3;31mx\u001b[my')).toEqual([
      { text: 'x', underline: true, italic: true, fg: 1 },
      { text: 'y' }
    ])
  })
})
