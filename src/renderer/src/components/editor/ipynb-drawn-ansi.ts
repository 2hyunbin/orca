import { ansiBlockRanges, parseAnsiBlock, type AnsiSegment, type AnsiStyle } from './ipynb-ansi'
import type { AnsiSourceRange } from '../../../../shared/ansi-escape-sequences'
import type { DrawnBlock } from './ipynb-output-tail'

type InterpretedBlock = { id: string; segments: AnsiSegment[]; style: AnsiStyle }
type CachedBlock = {
  incoming: string
  inputs: readonly DrawnBlock[]
  end: number
  length: number
  result: InterpretedBlock
  unsettled: boolean
}
type RangeAnalysis = { text: string; start: number; ranges: AnsiSourceRange[]; next: number }
const interpreted = new WeakMap<DrawnBlock, Map<number, CachedBlock>>()

function styleKey(style: AnsiStyle): string {
  return JSON.stringify([style.fg, style.bg, style.bold, style.italic, style.underline])
}

function analyze(text: string, start: number): RangeAnalysis {
  const ranges: AnsiSourceRange[] = []
  for (const range of ansiBlockRanges(text).sort((a, b) => a.start - b.start)) {
    const previous = ranges.at(-1)
    if (previous && range.start < previous.end) {
      previous.end = Math.max(previous.end, range.end)
    } else {
      ranges.push({ ...range })
    }
  }
  return { text, start, ranges, next: 0 }
}

/** Unresolved controls own only their dependency range; closed slices keep their parsed runs. */
export function interpretDrawnBlocks(blocks: readonly DrawnBlock[]): InterpretedBlock[] {
  const results: InterpretedBlock[] = []
  const active = new Map<DrawnBlock, Map<number, CachedBlock>>()
  let style: AnsiStyle = {}
  let analysis: RangeAnalysis | undefined
  let position = 0
  let offset = 0
  for (let index = 0; index < blocks.length;) {
    const block = blocks[index]
    if (!block.text.length) {
      index += 1
      continue
    }
    const incoming = styleKey(style)
    let entry = interpreted.get(block)?.get(offset)
    if (
      !entry ||
      entry.incoming !== incoming ||
      (entry.unsettled && index + entry.inputs.length !== blocks.length) ||
      !entry.inputs.every((input, at) => input === blocks[index + at])
    ) {
      if (!analysis || position >= analysis.start + analysis.text.length) {
        analysis = analyze(block.text.slice(offset), position)
        if (
          index + 1 < blocks.length &&
          analysis.ranges.some((range) => range.end > block.text.length - offset)
        ) {
          analysis = analyze(
            analysis.text +
              blocks
                .slice(index + 1)
                .map((part) => part.text)
                .join(''),
            position
          )
        }
      }
      const start = position - analysis.start
      let end = start + block.text.length - offset
      while (analysis.next < analysis.ranges.length && analysis.ranges[analysis.next].end <= end) {
        analysis.next += 1
      }
      const crossing = analysis.ranges[analysis.next]
      if (crossing && crossing.start < end) {
        end = crossing.start > start ? crossing.start : Math.min(crossing.end, analysis.text.length)
      }
      const text = analysis.text.slice(start, end)
      let lastIndex = index
      let lastOffset = offset + text.length
      while (lastOffset > blocks[lastIndex].text.length) {
        lastOffset -= blocks[lastIndex].text.length
        lastIndex += 1
      }
      entry = {
        incoming,
        inputs: blocks.slice(index, lastIndex + 1),
        end: lastOffset,
        length: text.length,
        result: { id: `${block.id}:${offset}`, ...parseAnsiBlock(text, style) },
        unsettled: !!crossing && crossing.start < end && crossing.end > end
      }
    }
    const entries = active.get(block) ?? new Map<number, CachedBlock>()
    entries.set(offset, entry)
    active.set(block, entries)
    results.push(entry.result)
    style = entry.result.style
    position += entry.length
    index += entry.inputs.length - 1
    offset = entry.end
    if (offset === blocks[index].text.length) {
      index += 1
      offset = 0
    }
  }
  // Keep only this partition, so changing current lines/styles cannot retain historical variants.
  for (const block of blocks) {
    const entries = active.get(block)
    if (entries) {
      interpreted.set(block, entries)
    } else {
      interpreted.delete(block)
    }
  }
  return results
}
