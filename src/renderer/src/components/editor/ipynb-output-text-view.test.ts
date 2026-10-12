import { describe, expect, it } from 'vitest'
import { applyKernelOutput, liveStreamView, type LiveOutputs } from './ipynb-kernel-outputs'
import { OUTPUT_VIEW_LINE_LIMIT, outputTextView } from './ipynb-output-text-view'
import { concatIpynbMultilineString, parseIpynbOutput } from './ipynb-parse'

const lines = (count: number, from = 0): string =>
  Array.from({ length: count }, (_, index) => `line ${from + index}\n`).join('')

describe('outputTextView', () => {
  it('draws short output whole', () => {
    expect(outputTextView('a\nb\n')).toEqual({ text: 'a\nb\n', truncated: false })
    expect(outputTextView('')).toEqual({ text: '', truncated: false })
    expect(outputTextView(lines(OUTPUT_VIEW_LINE_LIMIT)).truncated).toBe(false)
  })

  it('draws the last lines of long output', () => {
    const view = outputTextView(lines(OUTPUT_VIEW_LINE_LIMIT + 3))
    expect(view).toEqual({ text: lines(OUTPUT_VIEW_LINE_LIMIT, 3), truncated: true })
  })

  it('counts an unfinished last line', () => {
    const view = outputTextView(`${lines(OUTPUT_VIEW_LINE_LIMIT)}partial`)
    expect(view.truncated).toBe(true)
    expect(view.text).toBe(`${lines(OUTPUT_VIEW_LINE_LIMIT - 1, 1)}partial`)
  })

  it('bounds a single unbroken line', () => {
    const view = outputTextView('x'.repeat(3 * 1024 * 1024))
    expect(view.truncated).toBe(true)
    expect(view.text.length).toBe(1024 * 1024)
  })

  it('keeps an earlier truncation when redrawn from its own text', () => {
    const view = outputTextView(lines(OUTPUT_VIEW_LINE_LIMIT + 1))
    expect(outputTextView(view.text, view.truncated)).toEqual(view)
  })
})

describe('liveStreamView', () => {
  const empty: LiveOutputs = { outputs: [], clearOnNextOutput: false }
  const stream = (chunks: string[]): LiveOutputs =>
    chunks.reduce(
      (live, text) => applyKernelOutput(live, 'stream', { name: 'stdout', text }),
      empty
    )

  it('matches the view of the whole text however the chunks split', () => {
    const text = `${lines(OUTPUT_VIEW_LINE_LIMIT + 50)}tail`
    for (const size of [7, 1000, 40_000, text.length]) {
      const chunks = Array.from({ length: Math.ceil(text.length / size) }, (_, index) =>
        text.slice(index * size, (index + 1) * size)
      )
      const live = stream(chunks)
      const output = live.outputs[0]
      expect(output.text).toBe(text)
      expect(liveStreamView(output)).toEqual(outputTextView(text))
    }
  })

  it('follows carriage-return rewrites of the last line', () => {
    const live = stream([lines(OUTPUT_VIEW_LINE_LIMIT + 1), '10%\r', '50%\r', '100%\n'])
    const output = live.outputs[0]
    expect(liveStreamView(output)).toEqual(outputTextView(String(output.text)))
    expect(liveStreamView(output)?.text.endsWith('100%\n')).toBe(true)
  })

  it('has no view for saved outputs', () => {
    expect(liveStreamView({ output_type: 'stream', name: 'stdout', text: 'a' })).toBeUndefined()
  })
})

describe('saved stream outputs', () => {
  const savedStream = (text: unknown) =>
    parseIpynbOutput({ output_type: 'stream', name: 'stdout', text })

  it('draws the end of a saved line array like the whole joined text', () => {
    const items = Array.from(
      { length: OUTPUT_VIEW_LINE_LIMIT + 20 },
      (_, index) => `line ${index}\r\n`
    )
    const joined = concatIpynbMultilineString(items)
    expect(savedStream(items)).toEqual({
      kind: 'stream',
      name: 'stdout',
      ...outputTextView(joined)
    })
  })

  it('keeps short saved output whole', () => {
    expect(savedStream(['a\n', 'b'])).toEqual({
      kind: 'stream',
      name: 'stdout',
      text: 'a\nb',
      truncated: false
    })
    expect(savedStream('a\r\nb')).toMatchObject({ text: 'a\nb', truncated: false })
  })
})
