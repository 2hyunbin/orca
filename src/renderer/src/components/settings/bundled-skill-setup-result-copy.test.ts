import { describe, expect, it } from 'vitest'
import { summarizeBundledSkillOutcomes } from '../../../../shared/bundled-skill-summary'
import {
  doneResult,
  planEntry,
  planOf,
  planOp,
  sharedEntry
} from '../skills/bundled-skill-plan-fixtures.test-support'
import { bundledSkillSetupChanges } from './bundled-skill-setup-copy'
import {
  bundledSkillSetupAttentionMessage,
  skillInstallResultLine
} from './bundled-skill-setup-result-copy'

function resultLine(plan: ReturnType<typeof planOf>): string {
  const result = doneResult(plan)
  return skillInstallResultLine(
    summarizeBundledSkillOutcomes(result),
    bundledSkillSetupChanges(plan, result)
  )
}

describe('setup result details', () => {
  it.each([
    ['edited', 'you edited this copy'],
    ['other', 'a different skill already uses this name'],
    ['unwritable', "Orca can't write to this folder"],
    ['unreadable', "Orca can't read every file in this copy"],
    ['busy', 'another skill install is still finishing here'],
    ['shared-not-current', 'the shared copy this folder uses is not Orca’s'],
    [undefined, 'this copy was kept as it is']
  ] as const)('names the agent for a %s copy', (reason, text) => {
    const plan = planOf([
      planEntry('orca-cli', [
        planOp('write', '/home/u/.agents/skills/orca-cli'),
        planOp('leave', '/home/u/.claude/skills/orca-cli', { reason })
      ])
    ])
    expect(resultLine(plan)).toBe(`Installed · Not updated in Claude Code: ${text}`)
  })

  it('uses plural edited-copy wording for several places', () => {
    const plan = planOf([
      planEntry('orca-cli', [
        planOp('write', '/home/u/.agents/skills/orca-cli'),
        planOp('leave', '/home/u/.claude/skills/orca-cli', { reason: 'edited' }),
        planOp('leave', '/home/u/.cursor/skills/orca-cli', { reason: 'edited', agents: ['cursor'] })
      ])
    ])
    expect(resultLine(plan)).toBe('Installed · Not updated in 2 places: you edited these copies')
  })

  it('keeps distinct reasons for several places', () => {
    const plan = planOf([
      planEntry('orca-cli', [
        planOp('write', '/home/u/.agents/skills/orca-cli'),
        planOp('leave', '/home/u/.claude/skills/orca-cli', { reason: 'edited' }),
        planOp('leave', '/home/u/.cursor/skills/orca-cli', { reason: 'other', agents: ['cursor'] })
      ])
    ])
    expect(resultLine(plan)).toBe(
      'Installed · Not updated in 2 places: you edited this copy; a different skill already uses this name'
    )
  })

  it('reports the backup only when a replacement finished', () => {
    const plan = planOf([sharedEntry('orca-cli', 'replace')])
    const result = doneResult(plan)
    expect(resultLine(plan)).toBe('Replaced · Your copy was saved as a backup')
    result.skills[0].ops[0].status = 'failed'
    expect(
      skillInstallResultLine(
        summarizeBundledSkillOutcomes(result),
        bundledSkillSetupChanges(plan, result)
      )
    ).toBe('Needs attention')
  })

  it('keeps the install-for suffix after a replacement', () => {
    const plan = planOf([
      planEntry('orca-cli', [
        planOp('replace', '/home/u/.agents/skills/orca-cli'),
        planOp('link', '/home/u/.cursor/skills/orca-cli', { agents: ['cursor'] })
      ])
    ])
    expect(resultLine(plan)).toBe(
      'Replaced · Your copy was saved as a backup · Installed for Cursor'
    )
  })
})

describe('setup attention details', () => {
  it.each([
    ['unwritable', "Needs attention · Orca can't write to ~/.claude/skills/orca-cli"],
    ['busy', 'Needs attention · Another skill install is still finishing here'],
    ['unreadable', "Needs attention · Orca can't read every file in this copy"],
    ['edited', 'Needs attention · You edited this copy'],
    ['other', 'Needs attention · A different skill already uses this name'],
    ['shared-not-current', 'Needs attention · The shared copy this folder uses is not Orca’s'],
    [undefined, 'Needs attention']
  ] as const)('explains a %s blocker', (reason, message) => {
    const plan = planOf([
      planEntry('orca-cli', [planOp('leave', '/home/u/.claude/skills/orca-cli', { reason })])
    ])
    expect(bundledSkillSetupAttentionMessage(plan)).toBe(message)
  })

  it('uses the owning Windows host’s home formatter', () => {
    const plan = planOf([
      planEntry('orca-cli', [
        planOp('leave', 'C:\\Users\\Agent\\.claude\\skills\\orca-cli', { reason: 'unwritable' })
      ])
    ])
    plan.homeDirectory = 'c:\\users\\agent'
    expect(bundledSkillSetupAttentionMessage(plan)).toBe(
      "Needs attention · Orca can't write to ~\\.claude\\skills\\orca-cli"
    )
  })

  it('keeps attention generic when there is no known blocker', () => {
    expect(bundledSkillSetupAttentionMessage(planOf([]))).toBe('Needs attention')
  })
})
