import { describe, expect, it } from 'vitest'
import { tokenizeCommandLine } from './agent-command-line-entrypoint'
import { recognizeAgentProcessFromCommandLine } from './agent-process-recognition'

describe('command-line token text', () => {
  it.each([
    ['  codex\t--model\nexample  ', ['codex', '--model', 'example']],
    [`a''b""c '' ""`, ['abc']],
    ['a\\ b c\\d "e\\ f"', ['a b', 'c\\d', 'e f']],
    ['"a\\\\b\\\"c"', ['a\\b"c']],
    ["'a\\b\"c'", ['a\\b"c']],
    ['before"middle space"after', ['beforemiddle spaceafter']],
    ['"unfinished value', ['unfinished value']],
    ['tail\\', ['tail\\']],
    ['界😀\ud800\\ \udfff', ['界😀\ud800 \udfff']],
    ['one\u00a0two\u2028three\ufefffour', ['one', 'two', 'three', 'four']]
  ])('preserves tokens in %j', (command, expected) => {
    expect(tokenizeCommandLine(command)).toEqual(expected)
  })

  it('recognizes options after a long quoted argument without reading its text as flags', () => {
    const prompt = `plain ${'text --print '.repeat(10_000)}`
    expect(recognizeAgentProcessFromCommandLine(`claude '${prompt}'`)).toEqual({
      agent: 'claude',
      processName: 'claude'
    })
    expect(recognizeAgentProcessFromCommandLine(`claude '${prompt}' --print`)).toBeNull()
  })
})
