import { expect, it } from 'vitest'
import { formatNativeChatQuote } from './native-chat-quote-selection'

it('keeps blank lines, Unicode whitespace, and bare carriage returns when quoting', () => {
  expect(formatNativeChatQuote('  first\r\n\t\n\u2003\nnext\rpart  ')).toBe(
    '> first\n>\n>\n> next\rpart\n\n'
  )
  expect(formatNativeChatQuote(' \r\n\t')).toBe('>\n\n')
})

it.each([65_535, 65_536, 65_537])('keeps CRLF intact after %i selected characters', (length) => {
  const line = 'a'.repeat(length)
  expect(formatNativeChatQuote(`${line}\r\n\t\r\nlast`)).toBe(`> ${line}\n>\n> last\n\n`)
})

it('keeps complete long lines between chunks and Unicode at their edges', () => {
  const prefix = 'row\n'.repeat(16_385)
  const line = `${'x'.repeat(130_000)}😀\ud800`
  expect(formatNativeChatQuote(`${prefix}${line}\n\u00a0\nlast`)).toBe(
    `${'> row\n'.repeat(16_385)}> ${line}\n>\n> last\n\n`
  )
})
