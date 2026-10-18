import { describe, expect, it } from 'vitest'
import { createTerminalAgentStatusProcessor } from './terminal-agent-status-processor'

describe('createTerminalAgentStatusProcessor', () => {
  it('returns OSC 9999 chunks untouched when no OSC 7501 record changed', () => {
    const process = createTerminalAgentStatusProcessor()
    const result = process('a\x1b]9999;{"state":"working","prompt":"p"}\x07b')
    expect(result.cleanData).toBe('ab')
    expect(result.programStatusPayloads).toBeUndefined()
  })

  it('appends OSC 7501 projections, marks them, and leaves the sequence in the stream', () => {
    const process = createTerminalAgentStatusProcessor()
    const data = 'x\x1b]7501;state=working:app=codex\x1b\\y'
    const result = process(data)
    expect(result.cleanData).toBe(data)
    expect(result.payloads).toMatchObject([{ state: 'working', agentType: 'codex' }])
    expect(result.programStatusPayloads?.has(result.payloads[0])).toBe(true)
    expect(result.lastPayloadCleanOffset).toBe(data.length - 1)
  })

  it('merges OSC 9999, OSC 7501 and a re-glyphed title in one chunk', () => {
    const process = createTerminalAgentStatusProcessor()
    const report = '\x1b]7501;state=working:app=claude-code\x1b\\'
    const result = process(
      `a\x1b]9999;{"state":"done","prompt":"p"}\x07${report}\x1b]0;Refactor\x07b`
    )
    // The working edge repaints the last known title before Claude's own glyphless one.
    expect(result.cleanData).toBe(`a${report}\x1b]2;⠂ Claude Code\x1b\\\x1b]0;⠂ Refactor\x07b`)
    expect(result.payloads).toMatchObject([{ state: 'done' }, { state: 'working' }])
    expect(result.programStatusPayloads?.has(result.payloads[1])).toBe(true)
    expect(result.programStatusPayloads?.has(result.payloads[0])).toBe(false)
    // The OSC 7501 payload ends after its own sequence, ahead of the title it implies.
    expect(result.lastPayloadCleanOffset).toBe(1 + report.length)
    expect(result.programStatusFacet).toMatchObject({ state: 'working' })
  })
})
