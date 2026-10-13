import { useEffect, useState } from 'react'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { SettingsRow, SettingsSubsectionHeader } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { getTerminalWindowsAdministratorSearchEntry } from './terminal-windows-search'
import { translate } from '@/i18n/i18n'

export function TerminalWindowsAdministratorSection(): React.JSX.Element {
  const [administrator, setAdministrator] = useState<boolean | null | undefined>()
  useEffect(() => {
    let active = true
    window.api.app.getWindowsAdministratorStatus().then(
      (status) => active && setAdministrator(status),
      () => active && setAdministrator(null)
    )
    return () => {
      active = false
    }
  }, [])

  const status =
    administrator === undefined
      ? translate('settings.terminal.windows.checkingAdministrator', 'Checking…')
      : administrator === null
        ? translate('settings.terminal.windows.unknownAdministrator', 'Unable to determine')
        : administrator
          ? translate('settings.terminal.windows.administratorStatus', 'Administrator')
          : translate('settings.terminal.windows.standardStatus', 'Standard user')

  return (
    <SearchableSetting {...getTerminalWindowsAdministratorSearchEntry()[0]}>
      <section className="space-y-3">
        <SettingsSubsectionHeader
          title={translate(
            'settings.terminal.windows.administratorMode',
            'Windows administrator mode'
          )}
          description={translate(
            'settings.terminal.windows.administratorModeDescription',
            'Administrator mode applies to the whole Orca desktop. Existing terminal hosts keep their original permissions.'
          )}
        />
        <SettingsRow
          label={translate(
            'settings.terminal.windows.desktopPermissions',
            'Orca desktop permissions'
          )}
          control={
            <span className="text-sm" role="status">
              {status}
            </span>
          }
        />
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button variant="outline" size="sm">
              {translate('settings.terminal.windows.restartInstructions', 'Restart instructions')}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-3 pt-3 text-sm">
              <ol className="list-decimal space-y-2 pl-5">
                <li>
                  {translate(
                    'settings.terminal.windows.administratorFinishWork',
                    'Finish your work in local terminals, then exit Orca.'
                  )}
                </li>
                <li>
                  {translate(
                    'settings.terminal.windows.administratorStartMenu',
                    'Find Orca in the Windows Start menu, right-click it, and choose Run as administrator. Approve Windows’ prompt using your own account.'
                  )}
                </li>
                <li>
                  {translate(
                    'settings.terminal.windows.administratorRestartDaemon',
                    'To replace a retained ordinary terminal host, open Settings → Terminal → Manage Sessions → Restart daemon. This ends local terminals on that daemon. New local terminals then inherit administrator permissions.'
                  )}
                </li>
              </ol>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'settings.terminal.windows.administratorHostScope',
                  'SSH and WSL permissions are controlled on their hosts. Orca CLI commands in external PowerShell windows must use the same administrator mode as Orca.'
                )}
              </p>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </section>
    </SearchableSetting>
  )
}
