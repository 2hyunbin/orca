import { describe, expect, it } from 'vitest'
import { detectAgentStatusFromTitle } from './agent-title-status'
import { extractAllOscTitles } from './osc-title-extraction'
import { createTerminalAgentStatusProcessor } from './terminal-agent-status-processor'

const osc7501 = (body: string): string => `\x1b]7501;${body}\x1b\\`
const title = (text: string): string => `\x1b]0;${text}\x07`

function titlesSeenByOrca(chunks: string[]): string[] {
  const process = createTerminalAgentStatusProcessor()
  return chunks.flatMap((chunk) => extractAllOscTitles(process(chunk).cleanData))
}

describe('program status title glyphs', () => {
  it('restores the glyphs Claude stops painting once OSC 7501 is answered', () => {
    // Byte order captured from Claude Code 2.1.302 under a terminal that answers the probe.
    const titles = titlesSeenByOrca([
      title('✳ Claude Code'),
      osc7501('state=idle:app=claude-code') + title('Claude Code'),
      osc7501('state=working:app=claude-code'),
      title('Tea or coffee notes.txt'),
      osc7501('state=blocked:kind=question:app=claude-code'),
      osc7501('state=working:app=claude-code'),
      osc7501('state=done:app=claude-code'),
      osc7501('state=clear') + title('')
    ])
    expect(titles).toEqual([
      '✳ Claude Code',
      // The idle edge repaints the last title, then Claude's own glyphless title follows.
      '✳ Claude Code',
      '✳ Claude Code',
      '⠂ Claude Code',
      '⠂ Tea or coffee notes.txt',
      '✳ Tea or coffee notes.txt',
      '⠂ Tea or coffee notes.txt',
      '✳ Tea or coffee notes.txt',
      ''
    ])
    expect(titles.map((text) => detectAgentStatusFromTitle(text))).toEqual([
      'idle',
      'idle',
      'idle',
      'working',
      'working',
      'idle',
      'working',
      'idle',
      null
    ])
  })

  it('leaves programs without a glyph profile, and the drawn stream, untouched', () => {
    const process = createTerminalAgentStatusProcessor()
    const data = osc7501('state=working:app=codex') + title('my session')
    expect(process(data).cleanData).toBe(data)
  })

  it('re-glyphs a title whose terminator arrives in a later chunk', () => {
    const process = createTerminalAgentStatusProcessor()
    process(osc7501('state=working:app=claude-code'))
    expect(process('\x1b]0;Refactor').cleanData).toBe('\x1b]0;⠂ Refactor')
  })

  it('keeps the payload offset ahead of the title it implies', () => {
    const process = createTerminalAgentStatusProcessor()
    process(title('Claude Code'))
    const report = osc7501('state=working:app=claude-code')
    const result = process(report)
    expect(result.cleanData).toBe(`${report}\x1b]2;⠂ Claude Code\x1b\\`)
    expect(result.lastPayloadCleanOffset).toBe(report.length)
  })
})
