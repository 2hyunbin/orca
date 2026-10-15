import type { TabCreateMenuOption } from './tab-create-menu-options'
import { resolveWindowsShellLaunchTarget } from './windows-shell-launch'
import type { WindowsTerminalCapabilities } from '@/lib/windows-terminal-capabilities'

export function selectTabCreateMenuOption(args: {
  option: TabCreateMenuOption
  queueTerminalFocus: () => void
  onNewTerminalTab: () => void
  onNewTerminalWithShell?: (shell: string) => void
  onNewBrowserTab: () => void
  onNewSimulatorTab?: () => void
  onNewFileTab?: () => void
  onOpenFileTab?: () => void
  defaultWindowsPowerShellImplementation: Parameters<typeof resolveWindowsShellLaunchTarget>[1]
  windowsTerminalCapabilities: WindowsTerminalCapabilities
}): void {
  const { option } = args
  switch (option.kind) {
    case 'new-terminal':
      args.queueTerminalFocus()
      args.onNewTerminalTab()
      return
    case 'new-terminal-shell':
      if (!args.onNewTerminalWithShell || !option.shell) {
        return
      }
      args.queueTerminalFocus()
      args.onNewTerminalWithShell(
        resolveWindowsShellLaunchTarget(
          option.shell,
          args.defaultWindowsPowerShellImplementation,
          args.windowsTerminalCapabilities.pwshAvailable
        )
      )
      return
    case 'new-browser':
      args.onNewBrowserTab()
      return
    case 'new-markdown':
      args.onNewFileTab?.()
      return
    case 'open-markdown':
      args.onOpenFileTab?.()
      return
    case 'new-simulator':
    case 'go-to-simulator':
      args.onNewSimulatorTab?.()
  }
}
