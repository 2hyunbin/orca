/**
 * The skills-CLI install an Orca server older than the bundled installer still needs.
 * Delete with LegacySkillSetupTerminal once servers without
 * `skills.install.bundled-orca.v1` age out.
 */
export function buildLegacyNpxSkillInstallCommand(skillNames: readonly string[]): string {
  const skillArgs = skillNames.flatMap((name) => ['--skill', name])
  // Why pinned: a bare `npx skills` can reuse a stale cached copy (#18687), and the commit
  // keeps the installed bytes matching this client's build.
  return [
    'npx',
    'skills@1.7.2',
    'add',
    `https://github.com/stablyai/orca/tree/${ORCA_BUILD_COMMIT}`,
    ...skillArgs,
    '--global'
  ].join(' ')
}
