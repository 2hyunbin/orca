import type { GlobalSettings } from '../../../shared/global-settings-types'
import { isRestoreSpawnIntent } from '../../../shared/host-spawn-admission'
import { shouldRunPowerShellAsAdministrator } from '../../../shared/windows-admin-terminal'
import type { PtySpawnOptions } from '../../providers/pty-provider-contract'

export function applyAdminPowerShellSetting(
  options: PtySpawnOptions,
  settings: Pick<GlobalSettings, 'terminalWindowsPowerShellAdministrator'> | undefined,
  wslDistro: string | null | undefined
): void {
  // Restores keep the original session's permissions or come back unelevated; never surprise-prompt.
  options.windowsRunAsAdministrator =
    !isRestoreSpawnIntent(options.spawnIntent) &&
    shouldRunPowerShellAsAdministrator({
      platform: process.platform,
      wslDistro,
      shell: options.shellOverride,
      enabled: settings?.terminalWindowsPowerShellAdministrator
    })
}
