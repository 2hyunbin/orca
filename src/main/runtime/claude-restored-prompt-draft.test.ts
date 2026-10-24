import { describe, expect, it } from 'vitest'
import { composerDraftShowsText } from '../../shared/terminal-composer-draft'
import { finalReadProjection } from './agent-transcript-replay-test-harness'

// The prompts the captures pasted before pressing Escape (see each fixture's meta note).
const WRAPPED =
  'Write a 3000-word short story about a lighthouse keeper named Mara who keeps a logbook of every ship, directly in your reply with no tools, and end it with the word FIN.'
const MULTILINE = [
  'Write a 3000-word story about a fox, directly in your reply, no tools.',
  'Use these characters:',
  '- a fox named Ash',
  '- a crow named Pip',
  '- an old farmer',
  'End it with the word FIN.'
].join('\n')

describe('a prompt Claude puts back after an early Escape', () => {
  it('reads as that prompt when it wraps across rows', async () => {
    const { draft } = await finalReadProjection('claude-interrupt-restores-wrapped-prompt', 120, 40)
    expect(draft).toContain('\n')
    expect(composerDraftShowsText(draft ?? '', WRAPPED)).toBe(true)
    expect(composerDraftShowsText(draft ?? '', `${WRAPPED} More.`)).toBe(false)
  })

  it('reads as that prompt when Claude folds the paste into a chip', async () => {
    const { draft } = await finalReadProjection(
      'claude-interrupt-restores-multiline-prompt',
      120,
      40
    )
    expect(draft).toMatch(/^\[Pasted text #\d+ \+5 lines\]$/)
    expect(composerDraftShowsText(draft ?? '', MULTILINE)).toBe(true)
    expect(composerDraftShowsText(draft ?? '', `${MULTILINE}\nOne more line.`)).toBe(false)
  })
})
