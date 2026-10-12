import { describe, expect, it } from 'vitest'
import { shouldRunPowerShellAsAdministrator } from './windows-admin-terminal'

describe('administrator PowerShell setting', () => {
  it.each(['powershell.exe', 'pwsh.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', undefined])(
    'elevates PowerShell %s only after opt-in',
    (shell) => {
      expect(shouldRunPowerShellAsAdministrator({ platform: 'win32', shell, enabled: true })).toBe(
        true
      )
      expect(shouldRunPowerShellAsAdministrator({ platform: 'win32', shell })).toBe(false)
    }
  )

  it.each(['cmd.exe', 'cmd', 'git-bash', 'bash.exe', 'wsl.exe', 'nu.exe', 'unknown.exe'])(
    'keeps %s at its usual permissions',
    (shell) => {
      expect(shouldRunPowerShellAsAdministrator({ platform: 'win32', shell, enabled: true })).toBe(
        false
      )
    }
  )

  it('uses execution-host boundaries for SSH, WSL, macOS and Linux', () => {
    for (const options of [
      { platform: 'darwin' },
      { platform: 'linux' },
      { platform: 'win32', connectionId: 'windows-ssh' },
      { platform: 'win32', wslDistro: 'Ubuntu' }
    ]) {
      expect(shouldRunPowerShellAsAdministrator({ ...options, enabled: true })).toBe(false)
    }
  })
})
