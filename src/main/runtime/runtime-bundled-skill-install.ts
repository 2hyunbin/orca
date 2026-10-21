import type {
  BundledSkillExecuteRequest,
  BundledSkillInstallResult,
  BundledSkillPlan,
  BundledSkillPlanRequest
} from '../../shared/bundled-skill-plan'
import { localBundledSkillInput } from '../skills/bundled-skill-install/local-host'
import {
  installBundledSkills,
  previewBundledSkillInstall,
  type BundledSkillServiceInput
} from '../skills/bundled-skill-install/service'
import { clearSkillDiscoveryCaches } from '../skills/skill-discovery-target'
import { resolveSkillInstallDestination } from '../skills/skill-install-destinations'
import type { RuntimeSkillCommandHost } from './runtime-skill-command-contract'
import {
  createSkillInstallAuthority,
  resolveSkillProviderRoots
} from './runtime-skill-install-authority'

// Why global and installed-only: this is the app's Update skills, which never adds a skill
// the user did not install. WSL and remote hosts plan on their own host (not here).
async function appInput(
  host: RuntimeSkillCommandHost,
  force: readonly string[] | undefined
): Promise<BundledSkillServiceInput> {
  const destination = await resolveSkillInstallDestination(
    { scope: 'global' },
    createSkillInstallAuthority(host)
  )
  // Why: a cloud transaction this process is still recovering holds the same paths.
  await host.skillTransactionRecovery
  return localBundledSkillInput({
    userDataPath: host.getUserDataPath(),
    destination,
    providerRootOverrides: await resolveSkillProviderRoots(host, destination),
    selection: { installedOnly: true, ...(force ? { force } : {}) }
  })
}

export async function planLocalBundledSkills(
  host: RuntimeSkillCommandHost,
  request: BundledSkillPlanRequest
): Promise<BundledSkillPlan> {
  return previewBundledSkillInstall(await appInput(host, request.force))
}

export async function executeLocalBundledSkills(
  host: RuntimeSkillCommandHost,
  request: BundledSkillExecuteRequest
): Promise<BundledSkillInstallResult> {
  const result = await installBundledSkills(await appInput(host, request.force), request.planDigest)
  // Discovery would otherwise serve its pre-install answer from cache.
  clearSkillDiscoveryCaches()
  return result
}
