import { canonicalizeWindowsShellOverride } from './windows-terminal-shell'

export function shouldRunPowerShellAsAdministrator(options: {
  platform: string
  connectionId?: string | null
  wslDistro?: string | null
  shell?: string
  enabled?: boolean
}): boolean {
  const shellName = options.shell?.trim().replaceAll('\\', '/').split('/').pop()
  const shell = shellName ? canonicalizeWindowsShellOverride(shellName) : 'powershell.exe'
  return (
    options.platform === 'win32' &&
    !options.connectionId &&
    !options.wslDistro &&
    options.enabled === true &&
    (shell === 'powershell.exe' || shell === 'pwsh.exe')
  )
}
