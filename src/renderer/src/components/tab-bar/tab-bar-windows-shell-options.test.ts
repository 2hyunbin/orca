import { describe, expect, it } from 'vitest'
import { buildWindowsShellMenuEntries } from './tab-bar-windows-shell-options'

const BASE = {
  showWindowsShellMenu: true,
  hasShellLauncher: true,
  projectRuntimeShellMenuMode: null,
  defaultWindowsShell: 'powershell.exe',
  gitBashAvailable: true,
  wslAvailable: true
}

describe('buildWindowsShellMenuEntries', () => {
  it('offers every available shell when the host sends no list', () => {
    expect(buildWindowsShellMenuEntries(BASE)?.map((entry) => entry.shell)).toEqual([
      'powershell.exe',
      'cmd.exe',
      'git-bash',
      'wsl.exe'
    ])
  })

  it("offers only the shells the workspace's host listed", () => {
    expect(
      buildWindowsShellMenuEntries({ ...BASE, hostHonouredShells: ['wsl.exe'] })?.map(
        (entry) => entry.shell
      )
    ).toEqual(['wsl.exe'])
  })

  it('offers no shell menu when the host honours none (an SSH workspace)', () => {
    expect(buildWindowsShellMenuEntries({ ...BASE, hostHonouredShells: [] })).toBeUndefined()
  })
})
