import { describe, expect, it } from 'vitest'
import { buildOrcaSkillCommand } from './agent-feature-install-commands'

describe('agent feature skill commands', () => {
  it('installs through the Orca CLI, one --skill per name', () => {
    expect(buildOrcaSkillCommand('install', ['orca-cli', 'orchestration'])).toBe(
      'orca skills install --skill orca-cli --skill orchestration'
    )
    expect(buildOrcaSkillCommand('update', ['orca-cli'])).toBe(
      'orca skills update --skill orca-cli'
    )
  })

  it('refuses an empty selection', () => {
    expect(() => buildOrcaSkillCommand('install', [])).toThrow('At least one skill name')
  })
})
