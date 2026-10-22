import type {
  BundledSkillInstallResult,
  BundledSkillPlan
} from '../../../../shared/bundled-skill-plan'
import { bundledSkillInstallAgents } from '../../../../shared/bundled-skill-summary'
import { agentNames } from '../skills/skill-plan-op-copy'
import { translate } from '@/i18n/i18n'

export type BundledSkillSetupChanges = {
  agents: string[]
  updates: boolean
}

/** Results count only operations that actually finished on the planned machine. */
export function bundledSkillSetupChanges(
  plan: BundledSkillPlan,
  result?: BundledSkillInstallResult
): BundledSkillSetupChanges {
  const entries = plan.skills.map((entry) => ({
    ...entry,
    ops: entry.ops.filter((op) => {
      if (!result) {
        return true
      }
      const outcome = result.skills.find((skill) => skill.name === entry.name)
      return (
        outcome?.status === 'ran' &&
        outcome.ops.some(
          (done) => done.path === op.path && done.kind === op.kind && done.status === 'done'
        )
      )
    })
  }))
  return {
    agents: bundledSkillInstallAgents(entries),
    updates: entries.some((entry) =>
      entry.ops.some((op) => ['update', 'replace', 'restore'].includes(op.kind))
    )
  }
}

export function bundledSkillSetupActionLabel(changes: BundledSkillSetupChanges): string {
  if (changes.updates) {
    return translate('auto.components.settings.AgentSkillSetupPanel.updateLabel', 'Update')
  }
  if (changes.agents.length > 1) {
    return translate(
      'auto.components.settings.bundledSkillSetupCopy.installForMore',
      'Install for {{value0}} more agents',
      { value0: changes.agents.length }
    )
  }
  const name = agentNames(changes.agents)
  return name
    ? translate(
        'auto.components.settings.bundledSkillSetupCopy.installForAgent',
        'Install for {{value0}}',
        { value0: name }
      )
    : translate('auto.components.settings.AgentSkillSetupPanel.installLabel', 'Install')
}

export function bundledSkillSetupResultHeadline(changes: BundledSkillSetupChanges): string {
  const installed =
    changes.agents.length > 1
      ? translate(
          'auto.components.settings.bundledSkillSetupCopy.installedForMore',
          'Installed for {{value0}} more agents',
          { value0: changes.agents.length }
        )
      : changes.agents.length === 1
        ? translate(
            'auto.components.settings.bundledSkillSetupCopy.installedForAgent',
            'Installed for {{value0}}',
            { value0: agentNames(changes.agents) }
          )
        : null
  const updated = translate('auto.components.skills.skillPlanOpCopy.updated', 'Updated')
  return changes.updates
    ? installed
      ? `${updated} · ${installed}`
      : updated
    : (installed ?? translate('auto.components.skills.skillPlanOpCopy.installed', 'Installed'))
}
