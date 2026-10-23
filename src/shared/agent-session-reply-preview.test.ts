import { describe, expect, it } from 'vitest'
import { nativeChatTurnReplyPreviews } from './agent-session-conversation-outline'

function replyPreview(text: string, earlier = 'Earlier reply'): string | undefined {
  return nativeChatTurnReplyPreviews(
    [earlier, text].map((text) => ({ role: 'assistant', blocks: [{ type: 'text', text }] })),
    ['turn', 'turn']
  ).get('turn')
}

describe('large reply-line previews', () => {
  it('keeps a line whose only letter is after the preview', () => {
    expect(replyPreview(`${'= '.repeat(5000)}Z`)).toBe(`${'= '.repeat(99)}=`)
  })

  it('falls back to earlier prose when a long line is only formatting or punctuation', () => {
    expect(replyPreview('**`* '.repeat(5000))).toBe('Earlier reply')
    expect(replyPreview('= '.repeat(5000))).toBe('Earlier reply')
    expect(replyPreview(`\n\n\`\`\`ts\n${'hidden text '.repeat(1000)}\n\`\`\``)).toBe(
      'Earlier reply'
    )
  })

  it('keeps the first prose after a large amount of removable formatting', () => {
    expect(replyPreview(`${'**`'.repeat(5000)}Finished **now** \`a.ts\`.`)).toBe(
      'Finished now a.ts.'
    )
  })

  it('removes list prefixes and collapses display whitespace after removing markers', () => {
    const whitespace = '\t\v\f \u00a0\u1680\u2000\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
    expect(replyPreview(`123. ${'**one**`two`'.repeat(400)}${whitespace}end`)).toBe(
      'onetwo'.repeat(34).slice(0, 200)
    )
    expect(replyPreview(`## ${'**` '.repeat(3000)}Done${whitespace}now`)).toBe('Done now')
  })

  it('combines short earlier lines with the bounded long-line preview', () => {
    expect(replyPreview(`Intro\r\n- ${'**x** '.repeat(5000)}`)).toBe(
      `Intro ${'x '.repeat(100)}`.slice(0, 200).trimEnd()
    )
  })

  it.each([
    { prefixLength: 198, expected: `${'x'.repeat(198)}😀` },
    { prefixLength: 199, expected: 'x'.repeat(199) },
    { prefixLength: 200, expected: 'x'.repeat(200) }
  ])(
    'preserves surrogate boundaries after $prefixLength code units',
    ({ prefixLength, expected }) => {
      const text = `${'x'.repeat(prefixLength)}😀${'**tail** '.repeat(1000)}`
      expect(replyPreview(text)).toBe(expected)
    }
  )
})
