import { describe, expect, it } from 'vitest'
import { createDetailsMatcher, matchDetailsHtmlBlock } from './details-markdown-html'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import {
  getMarkdownFenceRanges,
  isInsideMarkdownFenceRange,
  type MarkdownFenceRanges
} from './markdown-fence-scanner'

function countRangeReads(ranges: MarkdownFenceRanges): {
  ranges: MarkdownFenceRanges
  getReads: () => number
} {
  let reads = 0
  const tracked = ranges.slice()
  ranges.forEach((range, index) => {
    Object.defineProperty(tracked, index, {
      get() {
        reads += 1
        return range
      }
    })
  })
  return {
    ranges: tracked,
    getReads: () => reads
  }
}

describe('Markdown fence membership', () => {
  it.each(['\n', '\r\n', '\r'])(
    'matches exhaustive membership at boundaries and out-of-order offsets with %j',
    (eol) => {
      const source = ['before', '```js', 'code', '```', 'between', '~~~', 'tail'].join(eol)
      const ranges = getMarkdownFenceRanges(source)
      const offsets = Array.from({ length: source.length + 4 }, (_, index) => index - 2)
      offsets.reverse()
      offsets.push(Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY)
      for (const offset of offsets) {
        expect(isInsideMarkdownFenceRange(offset, ranges)).toBe(
          ranges.some(([start, end]) => offset >= start && offset < end)
        )
      }
      expect(isInsideMarkdownFenceRange(0, [])).toBe(false)
    }
  )

  it.each([65_533, 65_534, 65_536])(
    'bounds lookup work near the end of a large document at offset %i',
    (offset) => {
      const original = Array.from(
        { length: 16_384 },
        (_, index) => [index * 4, index * 4 + 2] as const
      )
      const tracked = countRangeReads(original)
      expect(isInsideMarkdownFenceRange(offset, tracked.ranges)).toBe(
        original.some(([start, end]) => offset >= start && offset < end)
      )
      expect(tracked.getReads()).toBeLessThanOrEqual(15)
    }
  )

  it('keeps late details tags outside fences without walking every preceding fence', () => {
    const prefix = '~~~\n</details>\n~~~\n'.repeat(4096)
    const details = '<details><summary>Note</summary>\n\nBody\n\n</details>'
    const content = prefix + details
    const tracked = countRangeReads(getMarkdownFenceRanges(content))
    expect(matchDetailsHtmlBlock(content, prefix.length, tracked.ranges)?.raw).toBe(details)
    expect(tracked.getReads()).toBeLessThanOrEqual(13)
  })

  it('matches nested details while ignoring fenced tags throughout sibling blocks', () => {
    const block =
      '<details><summary>Note</summary>\n\n~~~\n</details>\n~~~\n<details><summary>Nested</summary>Body</details>\n</details>\n'
    const content = block.repeat(64)
    const match = createDetailsMatcher(content)
    for (let index = 63; index >= 0; index -= 1) {
      expect(match(index * block.length)?.raw).toBe(block.slice(0, -1))
    }
  })
})

// Timings are evidence; the range-read budgets above are the deterministic CI gate.
it.skipIf(process.env.ORCA_MARKDOWN_FENCE_BENCHMARK !== '1')(
  'measures production encoding at supported Markdown document sizes',
  () => {
    const codec = createRichMarkdownEditorCodec('0'.repeat(32))
    const block = '<details><summary>Note</summary>\n\n~~~\n</details>\n~~~\n</details>\n'
    const encodedBlock = `${codec.transport.create('block-html', block.slice(0, -1))}\n`
    for (const count of [1000, 3000, 9000]) {
      const content = block.repeat(count)
      const expected = encodedBlock.repeat(count)
      for (let warmup = 0; warmup < 3; warmup += 1) {
        expect(encodeRawMarkdownHtmlForRichEditor(content, codec)).toBe(expected)
      }
      const samples: number[] = []
      for (let run = 0; run < 9; run += 1) {
        const start = performance.now()
        const result = encodeRawMarkdownHtmlForRichEditor(content, codec)
        samples.push(performance.now() - start)
        expect(result).toBe(expected)
      }
      samples.sort((left, right) => left - right)
      process.stdout.write(
        `${JSON.stringify({
          details: count,
          sourceBytes: content.length,
          samplesMs: samples,
          medianMs: samples[4],
          p95Ms: samples[8]
        })}\n`
      )
    }
  }
)
