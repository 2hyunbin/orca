import { resolveSystemClaudeHookTarget } from '../claude/claude-hook-target'
import {
  provisionClaudeAccountProfile,
  type ClaudeProfileSetupReport
} from './claude-profile-setup'
import { wslClaudeProfile } from './claude-profile-wsl-paths'

/** Runs on the guest so the copied settings and hook installer share System default. */
export async function provisionWslClaudeAccountProfile(
  userHome: string,
  distro: string,
  accountId: string
): Promise<ClaudeProfileSetupReport> {
  const { dataRoot, profile } = wslClaudeProfile(userHome, distro, accountId)
  return provisionClaudeAccountProfile({
    dataRoot,
    profile,
    userHome,
    userConfigDir: (await resolveSystemClaudeHookTarget()).configDir,
    installHooks: null
  })
}
