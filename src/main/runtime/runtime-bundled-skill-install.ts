import { join } from 'node:path'
import type {
  BundledSkillInstallResult,
  BundledSkillLocalExecuteRequest,
  BundledSkillLocalPlanRequest,
  BundledSkillPlan
} from '../../shared/bundled-skill-plan'
import { isSkillInstallProviderId } from '../../shared/skill-install-providers'
import {
  localBundledSkillInput,
  type BundledSkillSelection
} from '../skills/bundled-skill-install/local-host'
import {
  installBundledSkills,
  previewBundledSkillInstall,
  type BundledSkillServiceInput
} from '../skills/bundled-skill-install/service'
import { createWslBundledSkillFilesystem } from '../skills/bundled-skill-install/wsl-filesystem'
import { clearSkillDiscoveryCaches } from '../skills/skill-discovery-target'
import { resolveSkillInstallDestination } from '../skills/skill-install-destinations'
import { detectSkillProvidersInWsl } from '../skills/skill-wsl-provider-detection'
import { getDefaultWslDistro } from '../wsl'
import { listConfirmedRunningWslDistros } from '../wsl-background-distro-gate'
import type { RuntimeSkillCommandHost } from './runtime-skill-command-contract'
import {
  createSkillInstallAuthority,
  resolveSkillProviderRoots
} from './runtime-skill-install-authority'

/** Agents in the guest read the guest's homes, with the guest's own env and agent detection. */
async function wslInput(
  host: RuntimeSkillCommandHost,
  wsl: NonNullable<BundledSkillLocalPlanRequest['wsl']>,
  selection: BundledSkillSelection
): Promise<BundledSkillServiceInput> {
  const distro = wsl.distro ?? getDefaultWslDistro()
  if (!distro) {
    throw new Error('skill-install-wsl-unavailable')
  }
  if (
    wsl.onlyIfRunning &&
    !(await listConfirmedRunningWslDistros()).some(
      (running) => running.toLowerCase() === distro.toLowerCase()
    )
  ) {
    throw new Error(`WSL ${distro} isn't running. Re-check to start it and check its skills.`)
  }
  const destination = await resolveSkillInstallDestination(
    { scope: 'global', executionTarget: { kind: 'wsl', distro } },
    createSkillInstallAuthority(host)
  )
  await host.skillTransactionRecovery
  const providerRootOverrides = await resolveSkillProviderRoots(host, {
    scope: 'global',
    homeDirectory: destination.homeDirectory,
    wslDistro: distro
  })
  return {
    destination,
    agents: (await detectSkillProvidersInWsl(distro)).filter(isSkillInstallProviderId),
    providerRootOverrides,
    // Why Windows userData: cloud installs into this guest from the app keep their state here.
    stateDirectory: join(host.getUserDataPath(), 'skill-installs'),
    filesystem: createWslBundledSkillFilesystem({
      distro,
      homeDirectory: destination.homeDirectory,
      providerRootOverrides
    }),
    ...selection
  }
}

/** Update never adds a skill the user did not install; only a named Install does. */
function appSelection(request: BundledSkillLocalPlanRequest): BundledSkillSelection {
  return {
    ...(request.names ? { names: request.names } : { installedOnly: true }),
    ...(request.force ? { force: request.force } : {})
  }
}

// Why global: a paired server or SSH host plans this on its own host over RPC.
async function appInput(
  host: RuntimeSkillCommandHost,
  request: BundledSkillLocalPlanRequest
): Promise<BundledSkillServiceInput> {
  const selection = appSelection(request)
  if (request.wsl) {
    return wslInput(host, request.wsl, selection)
  }
  const destination = await resolveSkillInstallDestination(
    { scope: 'global' },
    createSkillInstallAuthority(host)
  )
  // Why: a cloud transaction this process is still recovering holds the same paths.
  await host.skillTransactionRecovery
  return localBundledSkillInput({
    userDataPath: host.getUserDataPath(),
    destination,
    claudeConfigDirectory: host.getClaudeConfigDirectory?.({ runtime: 'host' }),
    selection
  })
}

export async function planLocalBundledSkills(
  host: RuntimeSkillCommandHost,
  request: BundledSkillLocalPlanRequest
): Promise<BundledSkillPlan> {
  return previewBundledSkillInstall(await appInput(host, request))
}

export async function executeLocalBundledSkills(
  host: RuntimeSkillCommandHost,
  { planDigest, request }: BundledSkillLocalExecuteRequest
): Promise<BundledSkillInstallResult> {
  const result = await installBundledSkills(await appInput(host, request), planDigest)
  // Discovery would otherwise serve its pre-install answer from cache.
  clearSkillDiscoveryCaches()
  return result
}
