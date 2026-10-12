import type { GlobalSettings } from '../../../shared/global-settings-types'
import { shouldRunPowerShellAsAdministrator } from '../../../shared/windows-admin-terminal'
import type { PtySpawnOptions } from '../../providers/pty-provider-contract'

export function applyAdminPowerShellSetting(
  options: PtySpawnOptions,
  settings: GlobalSettings | undefined,
  wslDistro: string | null | undefined
): void {
  options.windowsRunAsAdministrator = shouldRunPowerShellAsAdministrator({
    platform: process.platform,
    wslDistro,
    shell: options.shellOverride,
    enabled: settings?.terminalWindowsPowerShellAdministrator
  })
}
