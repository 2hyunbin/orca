import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

afterEach(() => vi.restoreAllMocks())

describe('rich Markdown unclosed document-link tails', () => {
  it('preserves open brackets and encodes later HTML without searching every suffix', () => {
    const codec = createRichMarkdownEditorCodec('0'.repeat(32))
    const prefix = `matrix ${'[[row '.repeat(4_000)}`
    const searches = vi.spyOn(String.prototype, 'indexOf')

    expect(encodeRawMarkdownHtmlForRichEditor(`${prefix}<b>tail</b>`, codec)).toBe(
      `${prefix}${codec.transport.create('inline-html', '<b>')}tail${codec.transport.create('inline-html', '</b>')}`
    )
    expect(searches.mock.calls.filter(([search]) => search === ']]')).toHaveLength(0)
  })

  it('converts a complete link before an unclosed tail and searches only its closing delimiter', () => {
    const codec = createRichMarkdownEditorCodec('0'.repeat(32))
    const tail = ` ${'[[pending '.repeat(4_000)}`
    const searches = vi.spyOn(String.prototype, 'indexOf')

    expect(encodeRawMarkdownHtmlForRichEditor(`[[README.md]]${tail}`, codec)).toBe(
      `${codec.transport.create('document-link', 'README.md')}${tail}`
    )
    expect(searches.mock.calls.filter(([search]) => search === ']]')).toHaveLength(1)
  })

  it('keeps overlapping closers, escaped links, and code spans intact before the unclosed tail', () => {
    const codec = createRichMarkdownEditorCodec('0'.repeat(32))
    expect(
      encodeRawMarkdownHtmlForRichEditor(
        '[[a]]] \\[[escaped]] `[[code]]` [[b|alias]] [[pending',
        codec
      )
    ).toBe(
      `${codec.transport.create('document-link', 'a')}] \\[[escaped]] \`[[code]]\` ${codec.transport.create('document-link', 'b|alias')} [[pending`
    )
  })
})
