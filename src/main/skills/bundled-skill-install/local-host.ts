import { join } from 'node:path'
import {
  isSkillInstallProviderId,
  type SkillInstallProviderId
} from '../../../shared/skill-install-providers'
import { detectInstalledAgentsWithShellPathHydration } from '../../preflight/installed-agent-detection'
import type { SkillProviderRootOverrides } from '../skill-provider-destinations'
import { resolveEnvironmentSkillProviderRoots } from '../skill-provider-runtime-roots'
import type { BundledSkillServiceInput } from './service'
import type { BundledSkillTargetRequest } from './targets'

/** What the caller chose; everything else about the host is resolved here. */
export type BundledSkillSelection = {
  names?: readonly string[]
  force?: readonly string[] | 'all'
  installedOnly?: boolean
}

/**
 * The one input builder for this machine, shared by the app and `orca skills`, so both plan
 * the same targets: detected agents, provider-root overrides and the cloud-install state dir.
 */
export async function localBundledSkillInput(options: {
  userDataPath: string
  destination: BundledSkillTargetRequest['destination']
  /** `--agent`; detected on this host when omitted. */
  agents?: readonly SkillInstallProviderId[]
  /** The app adds Orca's own Claude profile; the CLI reads the environment. */
  providerRootOverrides?: SkillProviderRootOverrides
  selection: BundledSkillSelection
}): Promise<BundledSkillServiceInput> {
  const { destination, selection } = options
  const agents =
    options.agents ??
    (await detectInstalledAgentsWithShellPathHydration()).filter(isSkillInstallProviderId)
  return {
    destination,
    agents,
    providerRootOverrides:
      options.providerRootOverrides ??
      (destination.scope === 'global' ? resolveEnvironmentSkillProviderRoots() : {}),
    stateDirectory: join(options.userDataPath, 'skill-installs'),
    ...(selection.names ? { names: selection.names } : {}),
    ...(selection.force ? { force: selection.force } : {}),
    ...(selection.installedOnly ? { installedOnly: true } : {})
  }
}
