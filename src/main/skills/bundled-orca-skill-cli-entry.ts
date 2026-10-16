// Why one entry: electron-vite replaces out/main, so the CLI can only load modules built as entries.
export {
  installBundledOrcaSkills,
  type BundledOrcaSkillInstallInput
} from './bundled-orca-skill-install'
export { planBundledOrcaSkills, type BundledOrcaSkillPlan } from './bundled-orca-skill-plan'
export {
  describeBundledSkillInstallResult,
  describeSkillConflictReason
} from './bundled-orca-skill-install-report'
export { resolveEnvironmentSkillProviderRoots } from './skill-provider-runtime-roots'
