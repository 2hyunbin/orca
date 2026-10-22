// COMPAT(wsl-bridge): removed when WSL runs as an orcad host.
export const ORCA_SKILLS_REPOSITORY_URL = 'https://github.com/stablyai/orca'

// Why: one skills CLI for every install rail. 1.5.x cannot fetch a commit, and a bare
// `npx skills` can reuse a stale cached copy or another binary (#18687).
export const SKILLS_CLI_VERSION = '1.7.2'

export const ORCA_CLI_SKILL_NAME = 'orca-cli'
export const COMPUTER_USE_SKILL_NAME = 'computer-use'
export const ORCHESTRATION_SKILL_NAME = 'orchestration'
export const EPHEMERAL_VMS_SKILL_NAME = 'orca-per-workspace-env'
export const ORCA_LINEAR_SKILL_NAME = 'orca-linear'
export const LINEAR_TICKETS_SKILL_NAME = 'linear-tickets'
export const LINEAR_AGENT_SKILL_NAMES = [ORCA_LINEAR_SKILL_NAME, LINEAR_TICKETS_SKILL_NAME] as const

// Why: `yes` and `agents` default off so every Settings/onboarding string a human
// pastes keeps its interactive prompts and the CLI's own agent detection. Only an
// unattended spawn, which nothing can answer, opts in.
export type AgentFeatureSkillCommandOptions = {
  /** Full commit the running build was made from. */
  sourceCommit: string
  global?: boolean
}

export function buildAgentFeatureSkillInstallArgs(
  skillNames: readonly string[],
  options: AgentFeatureSkillCommandOptions
): string[] {
  if (skillNames.length === 0) {
    throw new Error('At least one skill name is required.')
  }
  const global = options.global ?? true
  // Why: one flag per name remains compatible with both single-value and variadic parsers.
  const skillArgs = skillNames.flatMap((name) => ['--skill', name])
  return [
    `skills@${SKILLS_CLI_VERSION}`,
    'add',
    // Why: pinned to the build's own commit so the installed bytes are the ones its bundled
    // manifest judges freshness against, on every channel (hourly builds have no tag in
    // this repo). `add` always re-copies, so the same command is install and update.
    `${ORCA_SKILLS_REPOSITORY_URL}/tree/${options.sourceCommit}`,
    ...skillArgs,
    ...(global ? ['--global'] : [])
  ]
}

export function buildAgentFeatureSkillInstallCommand(
  skillNames: readonly string[],
  options: AgentFeatureSkillCommandOptions
): string {
  return `npx ${buildAgentFeatureSkillInstallArgs(skillNames, options).join(' ')}`
}
