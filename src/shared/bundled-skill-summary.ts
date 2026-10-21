import {
  isBundledSkillOpKind,
  type BundledSkillInstallResult,
  type BundledSkillLeaveReason,
  type BundledSkillOpKind,
  type BundledSkillOutcome,
  type BundledSkillPlan,
  type BundledSkillPlanEntry
} from './bundled-skill-plan'

/** Ordered by precedence: a skill shows its highest state. */
export type BundledSkillPlanState = 'current' | 'attention' | 'install' | 'update' | 'repair'

const PLAN_STATE_ORDER: readonly BundledSkillPlanState[] = [
  'current',
  'attention',
  'install',
  'update',
  'repair'
]

// Why a Record: adding an op kind fails to compile until it is summarised; a kind this
// build does not know (a newer server) reads as `attention` at runtime.
const OP_PLAN_STATE: Readonly<Record<BundledSkillOpKind, BundledSkillPlanState>> = {
  keep: 'current',
  leave: 'attention',
  write: 'install',
  link: 'install',
  copy: 'install',
  update: 'update',
  replace: 'update',
  restore: 'repair'
}

export const BUNDLED_SKILL_LEAVE_REASON_TEXT: Readonly<Record<BundledSkillLeaveReason, string>> = {
  edited: "You've changed this copy",
  other: 'A different skill already uses this name',
  unwritable: "Orca can't write to this folder",
  busy: 'Another skill install is still finishing here',
  'shared-not-current': 'The shared copy this folder uses is not Orca’s'
}

function opPlanState(kind: string): BundledSkillPlanState {
  return isBundledSkillOpKind(kind) ? OP_PLAN_STATE[kind] : 'attention'
}

export function bundledSkillPlanState(entry: BundledSkillPlanEntry): BundledSkillPlanState {
  return entry.ops.reduce<BundledSkillPlanState>((highest, op) => {
    const state = opPlanState(op.kind)
    return PLAN_STATE_ORDER.indexOf(state) > PLAN_STATE_ORDER.indexOf(highest) ? state : highest
  }, 'current')
}

export type BundledSkillPlanSummary = {
  /** Badge: only global-scope rewrites; link-only work is "Install for <agent>", never an update. */
  badge: 'update' | 'repair' | null
  /** Whether running the plan would change anything. */
  hasWork: boolean
  skills: { name: string; state: BundledSkillPlanState }[]
}

export function summarizeBundledSkillPlan(plan: BundledSkillPlan): BundledSkillPlanSummary {
  const skills = plan.skills.map((entry) => ({
    name: entry.name,
    state: bundledSkillPlanState(entry)
  }))
  const states = new Set(skills.map((skill) => skill.state))
  const global = plan.scope === 'global'
  return {
    badge:
      global && states.has('repair') ? 'repair' : global && states.has('update') ? 'update' : null,
    // Leftover swap siblings count: a stray released `.orca-old` would otherwise wait to be
    // restored once the user deletes the skill.
    hasWork:
      skills.some((skill) => ['install', 'update', 'repair'].includes(skill.state)) ||
      plan.skills.some((entry) => entry.ops.some((op) => op.cleanup.length > 0)),
    skills
  }
}

/** Changes whenever the skills the badge counts, or the bytes they would get, change. */
export function bundledSkillNudgeKey(hostId: string, plan: BundledSkillPlan): string | null {
  const counted = plan.skills
    .filter((entry) => ['update', 'repair'].includes(bundledSkillPlanState(entry)))
    .map((entry) => `${entry.name}@${entry.digest}`)
    .sort()
  return plan.scope === 'global' && counted.length > 0
    ? `bundled-skill:v1:${hostId}:${counted.join(',')}`
    : null
}

export type BundledSkillOutcomeText =
  | 'Updated'
  | 'Installed'
  | 'Linked'
  | 'No change'
  | 'Needs attention'

const DONE_TEXT: Readonly<Record<BundledSkillOpKind, BundledSkillOutcomeText | null>> = {
  keep: null,
  leave: 'Needs attention',
  write: 'Installed',
  copy: 'Installed',
  link: 'Linked',
  update: 'Updated',
  replace: 'Updated',
  // Why: a restore puts back the copy an interrupted update moved aside; it still needs one.
  restore: 'Needs attention'
}
const OUTCOME_TEXT_ORDER: readonly BundledSkillOutcomeText[] = [
  'No change',
  'Linked',
  'Installed',
  'Updated',
  'Needs attention'
]

export function bundledSkillOutcomeText(outcome: BundledSkillOutcome): BundledSkillOutcomeText {
  if (outcome.status !== 'ran') {
    return 'Needs attention'
  }
  return outcome.ops.reduce<BundledSkillOutcomeText>((highest, op) => {
    // Refusals, `changed`, skips and failures are never success.
    const text =
      op.status === 'done' && isBundledSkillOpKind(op.kind)
        ? (DONE_TEXT[op.kind] ?? 'No change')
        : 'Needs attention'
    return OUTCOME_TEXT_ORDER.indexOf(text) > OUTCOME_TEXT_ORDER.indexOf(highest) ? text : highest
  }, 'No change')
}

export type BundledSkillResultSummary = {
  ok: boolean
  /** The CLI's exit code. */
  exitCode: 0 | 1
  skills: { name: string; text: BundledSkillOutcomeText }[]
}

export function summarizeBundledSkillOutcomes(
  result: BundledSkillInstallResult
): BundledSkillResultSummary {
  const skills = result.skills.map((outcome) => ({
    name: outcome.name,
    text: bundledSkillOutcomeText(outcome)
  }))
  const ok = skills.every((skill) => skill.text !== 'Needs attention')
  return { ok, exitCode: ok ? 0 : 1, skills }
}
