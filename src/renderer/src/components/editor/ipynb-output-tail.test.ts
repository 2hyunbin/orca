import { describe, expect, it, vi } from 'vitest'
import { applyKernelOutput, type LiveOutputs } from './ipynb-kernel-outputs'
import { DRAWN_OUTPUT_CHARS, DRAWN_OUTPUT_LINES, drawnTail } from './ipynb-output-tail'
import { concatIpynbMultilineString, parseIpynbOutput } from './ipynb-parse'

const lines = (count: number, from = 0): string =>
  Array.from({ length: count }, (_, index) => `line ${from + index}\n`).join('')

function drawnOf(output: unknown): unknown {
  const parsed = parseIpynbOutput(output)
  return parsed?.kind === 'stream'
    ? { text: parsed.drawn.text, truncated: parsed.drawn.truncated }
    : undefined
}

describe('drawn output tail', () => {
  it('draws the last lines, or the last units of one endless line', () => {
    expect(drawnTail(lines(DRAWN_OUTPUT_LINES))).toEqual({
      text: lines(DRAWN_OUTPUT_LINES),
      truncated: false
    })
    expect(drawnTail(lines(DRAWN_OUTPUT_LINES + 3))).toEqual({
      text: lines(DRAWN_OUTPUT_LINES, 3),
      truncated: true
    })
    const endless = drawnTail(`a\n${'😀'.repeat(DRAWN_OUTPUT_CHARS / 2)}!`)
    // Never starts on half of a surrogate pair.
    expect(endless).toEqual({
      text: `${'😀'.repeat(DRAWN_OUTPUT_CHARS / 2 - 1)}!`,
      truncated: true
    })
  })

  it('draws saved line arrays like the joined text, normalising CRLF only in the drawn end', () => {
    const text = [...lines(DRAWN_OUTPUT_LINES + 10).split(/(?<=\n)/), 'last\r\n', 'end']
    expect(drawnOf({ output_type: 'stream', name: 'stdout', text })).toEqual(
      drawnTail(text.join('').replace(/\r\n/g, '\n'))
    )
  })

  it('clips giant saved items while preserving normalized units, separators and surrogate cuts', () => {
    for (const text of [
      ['x'.repeat(4 * DRAWN_OUTPUT_CHARS), '\r', '😀end'],
      ['\r\n'.repeat(DRAWN_OUTPUT_CHARS), '', 'last\r', 'end'],
      ['prefix', '😀'.repeat(DRAWN_OUTPUT_CHARS), '']
    ]) {
      const expected = drawnTail(concatIpynbMultilineString(text))
      const normalize = vi.spyOn(String.prototype, 'replace')
      try {
        const actual = drawnOf({ output_type: 'stream', text })
        const largest = Math.max(...normalize.mock.contexts.map((value) => String(value).length))
        expect(largest).toBeLessThanOrEqual(2 * DRAWN_OUTPUT_CHARS + 2)
        expect(actual).toEqual(expected)
      } finally {
        normalize.mockRestore()
      }
    }
  })

  it('keeps a live stream drawn end equal to the tail of its whole text across chunk boundaries', () => {
    let seed = 0x7a11
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed
    }
    const pieces = ['x', 'yy\n', '\r', '\r\n', '\n', '😀', '\ud83d', '\ude80', '10%\r']
    const chunks = [lines(DRAWN_OUTPUT_LINES + 20), 'z'.repeat(DRAWN_OUTPUT_CHARS + 7), 'a\r']
    for (let frame = 0; frame < 400; frame += 1) {
      let chunk = ''
      for (let index = next() % 40; index > 0; index -= 1) {
        chunk += pieces[next() % pieces.length]
      }
      chunks.push(frame % 97 === 0 ? `${chunk}${'w'.repeat(DRAWN_OUTPUT_CHARS / 2)}\r` : chunk)
    }
    let live: LiveOutputs = { outputs: [], clearOnNextOutput: false }
    for (const text of chunks) {
      live = applyKernelOutput(live, 'stream', { name: 'stdout', text })
      const output = live.outputs[0]
      expect(drawnOf(output)).toEqual(drawnTail(String(output?.text)))
    }
  })
})
