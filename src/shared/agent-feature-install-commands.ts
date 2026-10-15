export const ORCA_CLI_SKILL_NAME = 'orca-cli'
export const COMPUTER_USE_SKILL_NAME = 'computer-use'
export const ORCHESTRATION_SKILL_NAME = 'orchestration'
export const EPHEMERAL_VMS_SKILL_NAME = 'orca-per-workspace-env'
export const ORCA_LINEAR_SKILL_NAME = 'orca-linear'
export const LINEAR_TICKETS_SKILL_NAME = 'linear-tickets'
export const LINEAR_AGENT_SKILL_NAMES = [ORCA_LINEAR_SKILL_NAME, LINEAR_TICKETS_SKILL_NAME] as const

/** The CLI command name copied commands start with before a runtime resolves it. */
export const ORCA_SKILL_COMMAND_EXECUTABLE = 'orca'

/**
 * `orca skills install|update --skill <name>...`, which installs the skills this Orca build
 * ships with Orca's own installer. Runtimes that register the CLI under another name rewrite
 * the leading executable (see buildSkillCommandForRuntime).
 */
export function buildOrcaSkillCommand(
  verb: 'install' | 'update',
  skillNames: readonly string[]
): string {
  if (skillNames.length === 0) {
    throw new Error('At least one skill name is required.')
  }
  // Why: one flag per name; `--skill` is repeatable in the Orca CLI.
  const skillArgs = skillNames.flatMap((name) => ['--skill', name])
  return [ORCA_SKILL_COMMAND_EXECUTABLE, 'skills', verb, ...skillArgs].join(' ')
}
