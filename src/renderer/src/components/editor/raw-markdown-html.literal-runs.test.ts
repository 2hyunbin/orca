import { afterEach, expect, it, vi } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

afterEach(() => vi.restoreAllMocks())

it.each(['\n', '\r\n', '\r'])(
  'copies literal text without checking the transport prefix at every character: %j',
  (newline) => {
    const codec = createRichMarkdownEditorCodec('0'.repeat(32))
    const prose = 'A paragraph about files and the workspace. '.repeat(4_096)
    const startsWith = vi.spyOn(String.prototype, 'startsWith')
    const output = encodeRawMarkdownHtmlForRichEditor(`${prose}${newline}<hr>`, codec)
    const prefixChecks = startsWith.mock.calls.filter(
      ([prefix]) => prefix === codec.transport.authoredPrefix
    ).length

    expect(output).toBe(
      `${prose}${newline}${codec.transport.create(newline === '\r' ? 'inline-html' : 'block-html', '<hr>')}`
    )
    expect(prefixChecks).toBeLessThanOrEqual(3)
  }
)

it('copies fenced lines literally and resumes encoding after the closing fence', () => {
  const codec = createRichMarkdownEditorCodec('0'.repeat(32))
  const fenced = ['```html', '<tag> [[doc]] \\` text '.repeat(4_096), '```', ''].join('\n')

  expect(encodeRawMarkdownHtmlForRichEditor(`${fenced}<b>after</b>`, codec)).toBe(
    `${fenced}${codec.transport.create('inline-html', '<b>')}after${codec.transport.create('inline-html', '</b>')}`
  )
})
