import type { BuiltInWindowsTerminalShell } from '../../../../shared/windows-terminal-shell'
import { WINDOWS_GIT_BASH_SHELL } from '../../../../shared/windows-terminal-shell'
import { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import type { WindowsTerminalCapabilities } from '@/lib/windows-terminal-capabilities'
import { useAppStore } from '@/store'
import { selectKnownWorktreeById } from '@/store/selectors'
import type { getProjectRuntimeShellMenuMode } from './use-tab-bar-runtime-model'

export type WindowsShellMenuEntry = {
  label: string
  shell: BuiltInWindowsTerminalShell
}

export function buildWindowsShellMenuEntries({
  showWindowsShellMenu,
  hasShellLauncher,
  projectRuntimeShellMenuMode,
  defaultWindowsShell,
  gitBashAvailable,
  wslAvailable,
  hostHonouredShells
}: {
  showWindowsShellMenu: boolean
  hasShellLauncher: boolean
  projectRuntimeShellMenuMode: ReturnType<typeof getProjectRuntimeShellMenuMode>
  defaultWindowsShell: string
  gitBashAvailable: boolean
  wslAvailable: boolean
  /** The workspace host's own list; absent from hosts that predate it. */
  hostHonouredShells?: readonly string[]
}): WindowsShellMenuEntry[] | undefined {
  if (!showWindowsShellMenu || !hasShellLauncher) {
    return undefined
  }
  const includeHostShells = projectRuntimeShellMenuMode !== 'wsl'
  const includeWslShell = projectRuntimeShellMenuMode !== 'host'
  const allShells: WindowsShellMenuEntry[] = []
  if (includeHostShells) {
    allShells.push(
      {
        label: translate('auto.components.tab.bar.TabBar.2148f65e04', 'PowerShell'),
        shell: 'powershell.exe'
      },
      {
        label: translate('auto.components.tab.bar.TabBar.1a8af49530', 'CMD Prompt'),
        shell: 'cmd.exe'
      }
    )
    if (gitBashAvailable) {
      allShells.push({
        label: translate('auto.components.tab.bar.TabBar.efb33546ff', 'Git Bash'),
        shell: WINDOWS_GIT_BASH_SHELL
      })
    }
  }
  if (includeWslShell && wslAvailable) {
    allShells.push({
      label: translate('auto.components.tab.bar.TabBar.d1afac112b', 'WSL'),
      shell: 'wsl.exe'
    })
  }
  const offeredShells = hostHonouredShells
    ? allShells.filter((entry) => hostHonouredShells.includes(entry.shell))
    : allShells
  if (offeredShells.length === 0) {
    return undefined
  }
  const defaultEntry =
    offeredShells.find((shell) => shell.shell === defaultWindowsShell) ?? offeredShells[0]
  return [defaultEntry, ...offeredShells.filter((shell) => shell.shell !== defaultEntry.shell)].map(
    (entry) => ({ label: entry.label, shell: entry.shell })
  )
}

export function useWindowsShellMenuEntries({
  worktreeId,
  windowsTerminalCapabilities,
  ...args
}: Omit<
  Parameters<typeof buildWindowsShellMenuEntries>[0],
  'gitBashAvailable' | 'wslAvailable' | 'hostHonouredShells'
> & {
  worktreeId: string
  windowsTerminalCapabilities: WindowsTerminalCapabilities
}): WindowsShellMenuEntry[] | undefined {
  const hostHonouredShells = useAppStore(
    (s) => selectKnownWorktreeById(s, worktreeId)?.windowsTerminalShells
  )
  const { showWindowsShellMenu, hasShellLauncher, projectRuntimeShellMenuMode } = args
  const { defaultWindowsShell } = args
  const { gitBashAvailable, wslAvailable } = windowsTerminalCapabilities
  return useMemo(
    () =>
      buildWindowsShellMenuEntries({
        showWindowsShellMenu,
        hasShellLauncher,
        projectRuntimeShellMenuMode,
        defaultWindowsShell,
        gitBashAvailable,
        wslAvailable,
        hostHonouredShells
      }),
    [
      defaultWindowsShell,
      gitBashAvailable,
      hasShellLauncher,
      hostHonouredShells,
      projectRuntimeShellMenuMode,
      showWindowsShellMenu,
      wslAvailable
    ]
  )
}
