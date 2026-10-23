import { describe, expect, it, vi } from 'vitest'
import { stripHtmlComments } from './html-comment-text'

describe('stripHtmlComments', () => {
  it.each([
    ['', ''],
    ['plain text', 'plain text'],
    ['one<!-- hidden -->two', 'onetwo'],
    ['<!-- first -->visible<!-- second -->', 'visible'],
    ['<!-- outer <!-- inner -->tail -->', 'tail -->'],
    ['<!-- unclosed', '<!-- unclosed'],
    ['<!-->', '<!-->'],
    ['<!--->', '<!--->'],
    ['<!---->', ''],
    ['<!-- hidden -->tail<!-- unclosed', 'tail<!-- unclosed'],
    ['<!-- hidden\r\n🐋 -->中文\ud800', '中文\ud800']
  ])('strips complete comments in %j', (input, expected) => {
    expect(stripHtmlComments(input)).toBe(expected)
  })

  it('keeps a separator where comments joined readable text', () => {
    expect(stripHtmlComments('one<!-- hidden -->two<!-- unclosed', ' ')).toBe(
      'one two<!-- unclosed'
    )
  })

  it('keeps an unclosed tail outside the comment search', () => {
    const prefix = '<!-- hidden -->'
    const tail = 'literal <!-- unfinished\n'.repeat(1024)
    const original = RegExp.prototype.exec
    const searchedLengths: number[] = []
    const spy = vi.spyOn(RegExp.prototype, 'exec').mockImplementation(function (
      this: RegExp,
      input: string
    ) {
      if (this.source.startsWith('<!--')) {
        searchedLengths.push(input.length)
      }
      return original.call(this, input)
    })
    let result: string
    try {
      result = stripHtmlComments(prefix + tail)
    } finally {
      spy.mockRestore()
    }
    expect(result).toBe(tail)
    expect(searchedLengths.length).toBeGreaterThan(0)
    expect(searchedLengths.every((length) => length <= prefix.length)).toBe(true)
  })
})
