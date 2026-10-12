import { describe, expect, it } from 'vitest'
import type { CommandSpec } from './args'
import { formatGroupHelp } from './help'
import { BROWSER_BASIC_COMMAND_SPECS } from './specs/browser-basic'
import { WORKSPACE_TAB_COMMAND_SPECS } from './specs/workspace-tabs'

function listedCommands(specs: CommandSpec[], groupPath: string[]): string[] {
  const output = formatGroupHelp(specs, groupPath)
  return output.split('\n').flatMap((line) => {
    const match = /^ {2}(\S.*?) +[A-Z]/.exec(line)
    return match ? [match[1]] : []
  })
}

describe('command group help', () => {
  it.each([
    ['tab', ['list', 'switch', 'close']],
    ['tab profile', []],
    ['browser profile', ['list', 'create', 'rm', 'set', 'show', 'use-default', 'clone']],
    ['browser page', ['show', 'current', 'create']]
  ])('lists the accepted commands under %s', (group, commands) => {
    expect(
      listedCommands(
        [...WORKSPACE_TAB_COMMAND_SPECS, ...BROWSER_BASIC_COMMAND_SPECS],
        group.split(' ')
      )
    ).toEqual(commands)
  })

  it.each([
    ['browser', 'profile'],
    ['tab', 'profile']
  ])('omits hidden commands under %s %s', (...groupPath) => {
    const hidden: CommandSpec = {
      path: ['browser', 'profile', 'secret'],
      aliases: [['tab', 'profile', 'secret']],
      summary: 'Hidden profile command',
      usage: 'orca browser profile secret',
      allowedFlags: [],
      hidden: true
    }

    expect(listedCommands([hidden], groupPath)).toEqual([])
  })

  it('lists a command once when canonical and multiple alias paths match', () => {
    const spec: CommandSpec = {
      path: ['browser', 'profile', 'list'],
      aliases: [
        ['browser', 'profile', 'ls'],
        ['tab', 'profile', 'list'],
        ['tab', 'profile', 'ls']
      ],
      summary: 'List profiles',
      usage: 'orca browser profile list',
      allowedFlags: []
    }

    expect(listedCommands([spec], ['browser', 'profile'])).toEqual(['list'])
    expect(listedCommands([spec], ['tab', 'profile'])).toEqual(['list'])
  })
})
