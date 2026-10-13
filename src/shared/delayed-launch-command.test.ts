import { expect, it } from 'vitest'
import { getLaunchCommandAfterDelay } from './delayed-launch-command'
import { recognizeAgentProcessFromCommandLine } from './agent-process-recognition'
import { COMMAND_TOKEN_SCAN_MAX_CHARS } from './command-token-scanner'

it.each([
  ['sleep 30 && claude', 'claude'],
  [' sleep 30&&codex "do not sleep 30 && claude"', 'codex "do not sleep 30 && claude"'],
  [
    '/bin/sleep .5 && /usr/bin/sleep 1m && "C:\\Program Files\\Orca\\codex.exe"',
    '"C:\\Program Files\\Orca\\codex.exe"'
  ]
])('extracts only the delayed launch hint from %s', (command, expected) => {
  expect(getLaunchCommandAfterDelay(command)).toBe(expected)
})

it.each([
  'echo "sleep 30 && claude"',
  'sleep 30 || claude',
  'sleep 30 | claude',
  'sleep 30 & claude',
  'sleep "$DELAY" && claude',
  'sleep 30; claude',
  'sleep-helper 30 && claude',
  'claude "sleep 30 && codex"',
  'sh -c "sleep 30 && claude"'
])('leaves unmodeled shell syntax intact: %s', (command) => {
  expect(getLaunchCommandAfterDelay(command)).toBe(command)
})

it('bounds prefix scanning without truncating the launch arguments', () => {
  const task = 'x'.repeat(COMMAND_TOKEN_SCAN_MAX_CHARS * 4)
  expect(getLaunchCommandAfterDelay(`sleep 30 && claude '${task}'`)).toBe(`claude '${task}'`)
  const command = `${' '.repeat(COMMAND_TOKEN_SCAN_MAX_CHARS)}sleep 30 && claude`
  expect(getLaunchCommandAfterDelay(command)).toBe(command)
})

it('does not turn a waiting shell process into live agent evidence', () => {
  expect(recognizeAgentProcessFromCommandLine('sleep 30 && claude')).toBeNull()
  expect(recognizeAgentProcessFromCommandLine('/bin/zsh -c "sleep 30 && claude"')).toBeNull()
})
