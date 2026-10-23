import { describe, expect, it } from 'vitest'
import { summarizeSkillMarkdown } from './skill-metadata'

describe('summarizeSkillMarkdown', () => {
  it('reads name and folded description from YAML frontmatter', () => {
    const summary = summarizeSkillMarkdown(`---
name: orca-cli
description: >-
  Use the orca CLI to drive a running editor;
  keep worktree comments current.
---

# Orca CLI
`)

    expect(summary).toEqual({
      name: 'orca-cli',
      description: 'Use the orca CLI to drive a running editor; keep worktree comments current.'
    })
  })

  it('falls back to heading and first paragraph when frontmatter is absent', () => {
    const summary = summarizeSkillMarkdown(`# Design Review

Use when reviewing UI implementation quality.
`)

    expect(summary).toEqual({
      name: 'Design Review',
      description: 'Use when reviewing UI implementation quality.'
    })
  })

  it.each(['\n', '\r\n'])('reads multiline fallback paragraphs with %j line endings', (newline) => {
    const markdown = [
      '# Design Review',
      '',
      '```markdown',
      '```',
      '  Review the interface.  ',
      '\tCheck its behavior.\t',
      '',
      'Ignore later paragraphs.'
    ].join(newline)

    expect(summarizeSkillMarkdown(markdown)).toEqual({
      name: 'Design Review',
      description: 'Review the interface. Check its behavior.'
    })
  })

  it.each(['', '# Next heading', '```typescript'])(
    'ends the fallback paragraph at %j',
    (terminator) => {
      expect(
        summarizeSkillMarkdown(
          `# Design Review\n\nReview the interface.\n${terminator}\nIgnore this.`
        )
      ).toEqual({ name: 'Design Review', description: 'Review the interface.' })
    }
  )

  it('keeps the whole line that crosses the fallback paragraph length threshold', () => {
    const firstLine = 'a'.repeat(240)
    const secondLine = 'b'.repeat(300)

    expect(summarizeSkillMarkdown(`${firstLine}\n${secondLine}\nIgnore this.`)).toEqual({
      name: null,
      description: `${firstLine} ${secondLine}`
    })
    expect(summarizeSkillMarkdown(`${secondLine}\nIgnore this.`)).toEqual({
      name: null,
      description: secondLine
    })
  })

  it('preserves bare carriage returns within a fallback paragraph line', () => {
    expect(summarizeSkillMarkdown('  First\rsecond\r\nthird\r')).toEqual({
      name: null,
      description: 'First\rsecond third'
    })
  })

  it.each(['', '# Heading\n\n```\n```\n'])('returns no paragraph for %j', (markdown) => {
    expect(summarizeSkillMarkdown(markdown).description).toBeNull()
  })
})

it.each(['', '\uFEFF'])('preserves the last CRLF frontmatter field with BOM %j', (bom) => {
  for (const fields of [
    ['name: actual-name', 'description: actual description'],
    ['description: actual description', 'name: actual-name']
  ]) {
    const markdown = `${bom}${['---', ...fields, '---', '# Fallback heading', '', 'Fallback paragraph'].join('\r\n')}`
    expect(summarizeSkillMarkdown(markdown)).toEqual({
      name: 'actual-name',
      description: 'actual description'
    })
  }
})
