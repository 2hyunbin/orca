import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeTransientCursorShowSequences } from './pane-terminal-cursor-sequencing'

const SHOW = '\x1b[?25h'
const HIDE = '\x1b[?25l'
const SYNC_END = '\x1b[?2026l'

afterEach(() => vi.restoreAllMocks())

describe('transient cursor shows', () => {
  it.each([
    ['plain output', 'plain output'],
    [`${SHOW}plain output`, `${SHOW}plain output`],
    [`${SHOW}redraw${HIDE}`, `redraw${HIDE}`],
    [`${SHOW}${SHOW}redraw${HIDE}${SHOW}`, `redraw${HIDE}${SHOW}`],
    [`${SHOW}\x1b[31mred\x1b[0m${HIDE}`, `\x1b[31mred\x1b[0m${HIDE}`],
    [`${SHOW}\x1b[12;4H${HIDE}`, `\x1b[12;4H${HIDE}`],
    [`${SHOW}redraw\x1b[12;4Htail`, `redraw\x1b[12;4H${SHOW}tail`],
    [`${SHOW}redraw\x1b[12;4ftail`, `redraw\x1b[12;4f${SHOW}tail`],
    [`${SHOW}redraw\x1b[4Gtail`, `redraw\x1b[4G${SHOW}tail`],
    [`${SHOW}redraw${SYNC_END}tail`, `redraw${SYNC_END}${SHOW}tail`],
    [`${SHOW}redraw\x1b[12;`, `${SHOW}redraw\x1b[12;`]
  ])('preserves output and final cursor placement for %j', (input, expected) => {
    expect(removeTransientCursorShowSequences(input)).toBe(expected)
  })

  it('bounds position searches when a later hide already makes the show transient', () => {
    const body = '\x1b[31mred\x1b[0m'.repeat(1000)
    const input = `${SHOW.repeat(32)}${body}${HIDE}${SHOW}`
    const indexOf = vi.spyOn(String.prototype, 'indexOf')

    const actual = removeTransientCursorShowSequences(input)
    const positionSearches = indexOf.mock.calls.filter(([needle]) => needle === '\x1b[').length
    indexOf.mockRestore()

    expect(actual).toBe(`${body}${HIDE}${SHOW}`)
    expect(positionSearches).toBeLessThanOrEqual(1)
  })
})
