import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  prepareBenchmark,
  runDescriptor
} from '../../config/scripts/check-job-log-byte-cap-benchmark.mjs'
import { createManifest } from '../../config/scripts/check-job-log-performance-cases.mjs'
import { ESCAPE_SEQUENCE_PATTERN, stripAnsiEscapeSequences } from './ansi-escape-sequences'
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
  it.each(['\x1b[', '\x9b'])(
    'keeps complete %j sequences across dense chunk boundaries',
    (intro) => {
      const progress = 'x\x1b[K'.repeat(16_630)
      for (let padding = 0; padding < 100; padding++) {
        const suffix = `${'a'.repeat(padding)}${intro}1;2H界😀\ud800${intro}0Ktail`
        expect(stripAnsiEscapeSequences(progress + suffix)).toBe(
          `${'x'.repeat(16_630)}${'a'.repeat(padding)}界😀\ud800tail`
        )
      }
    }
  )
  it('preserves CSI parameters longer than a chunk and unfinished sequences', () => {
    const progress = 'x\x1b[K'.repeat(16_630)
    const prefix = 'x'.repeat(16_630)
    const parameters = '1;'.repeat(40_000)
    expect(stripAnsiEscapeSequences(`${progress}\x1b[${parameters}mend`)).toBe(`${prefix}end`)
    expect(stripAnsiEscapeSequences(`${progress}\x9b${parameters}mend`)).toBe(`${prefix}end`)
    expect(stripAnsiEscapeSequences(`${progress}\x1b[${parameters}`)).toBe(prefix + parameters)
    expect(stripAnsiEscapeSequences(`${progress}\x9b${parameters}`)).toBe(
      `${prefix}\x9b${parameters}`
    )
    for (const intro of ['\x1b[', '\x9b']) {
      const interrupted = `${parameters}\nvisible`
      expect(stripAnsiEscapeSequences(`${progress}${intro}${interrupted}\x1b[Kend`)).toBe(
        `${prefix}${intro === '\x9b' ? intro : ''}${interrupted}end`
      )
    }
  })
  it('preserves sparse escapes and Unicode in long output', () => {
    const text = 'α😀\ud800\udfff\r\n'.repeat(10_000)
    expect(stripAnsiEscapeSequences(`${text}\x1b[Kend`)).toBe(`${text}end`)
    expect(stripAnsiEscapeSequences(`\x1b[0m${text}`)).toBe(text)
    expect(stripAnsiEscapeSequences(text)).toBe(text)
    expect(stripAnsiEscapeSequences('x\x1b[K'.repeat(8_000) + text)).toBe('x'.repeat(8_000) + text)
    expect(stripAnsiEscapeSequences('\x1b[31m\x1b[0m'.repeat(20_000))).toBe('')
  })
  it('preserves unrelated controls and incomplete generic escapes', () => {
    expect(stripAnsiEscapeSequences('a\x1b(Bb\x1bc\x1b\\c')).toBe('abc')
    expect(stripAnsiEscapeSequences('\x00\x01\x18\x1a\x7f\x9c\t\r\n\x1b ')).toBe(
      '\x00\x01\x18\x1a\x7f\x9c\t\r\n\x1b '
    )
  })
  it('matches the exported generic grammar at every byte and intermediate boundary', () => {
    for (const intermediates of ['', ' ', ' /']) {
      for (let unit = 0; unit <= 0xff; unit++) {
        const input = `a\x1b${intermediates}${String.fromCharCode(unit)}`
        expect(stripAnsiEscapeSequences(input)).toBe(input.replace(ESCAPE_SEQUENCE_PATTERN, ''))
      }
    }
  })
  it.each([
    ['a\x1b /\x1bc', 'a\x1b /'],
    ['a\x1b /\x00\x1b~b', 'a\x1b /\x00b'],
    ['a\x1b\x1b /0b', 'a\x1bb'],
    ['a\x1b /\x7fb\x1b ', 'a\x1b /\x7fb\x1b ']
  ])('keeps failed generic matches literal before later escapes in %j', (input, expected) => {
    expect(stripAnsiEscapeSequences(input)).toBe(expected)
  })
  it('collects dense generic removals across owned block boundaries without altering UTF-16', () => {
    const visible = '界\ud800a😀\udfff'
    const input = `${visible}\x1b(B`.repeat(4097)
    expect(stripAnsiEscapeSequences(input)).toBe(visible.repeat(4097))
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

// Manual benchmark: opt in with ORCA_CHECK_LOG_PERF=1.
describe.runIf(process.env.ORCA_CHECK_LOG_PERF === '1')(
  'near-cap unfinished 7-bit stripping completion',
  { concurrent: false },
  () => {
    let context: Awaited<ReturnType<typeof prepareBenchmark>>
    beforeAll(async () => {
      context = await prepareBenchmark(process.cwd(), { compareBaseline: false })
    }, 15_000)
    afterAll(async () => {
      await context?.cleanup()
    })
    it.each(['osc', 'dcs'])(
      'completes %s warmups and a sample under the unchanged child watchdog',
      async (family) => {
        const descriptor = createManifest().find(
          (item) =>
            item.mode === 'direct' &&
            item.arm === 'proposed' &&
            item.family === family &&
            item.width === 7 &&
            item.bytes === 63 * 1024 * 1024 &&
            item.sample === 0
        )
        expect(descriptor).toBeDefined()
        const result = await runDescriptor(context, descriptor)
        expect(result.status).toBe('completed')
        expect(result.samples).toHaveLength(1)
      },
      15_000
    )
  }
)
