import { ipcMain } from 'electron'
import type {
  SshConfigHostListArgs,
  SshTargetCreateInput,
  SshTargetUpdateInput
} from '../../shared/ssh-types'
import {
  listUserSshConfigHostSummaries,
  resolveUserSshConfigHost
} from '../ssh/ssh-config-host-picker'
import { getSshTargetRegistryStore, setSshTargetMutations } from '../ssh/ssh-target-registry'
import { createSshTargetMutations, takeSshTargetRepoReadoptions } from '../ssh/ssh-target-mutations'
import { getCurrentMainWindow } from './ssh-ipc-context'
import { removeRegisteredSshTarget } from './ssh-session-teardown'
import { notifyReposChanged } from './repos/repos-changed-notification'

export { assertNotManagedServerHost } from '../ssh/ssh-target-mutations'

export function registerSshTargetCrudHandlers(): void {
  const changed = () => notifyReposChanged(getCurrentMainWindow())
  const mutations = createSshTargetMutations({
    notifyReposChanged: changed,
    removeTarget: removeRegisteredSshTarget
  })
  setSshTargetMutations(mutations)

  ipcMain.handle('ssh:listTargets', () => {
    return getSshTargetRegistryStore()!.listTargets()
  })

  ipcMain.handle('ssh:listRemovedTargetLabels', () => {
    return getSshTargetRegistryStore()!.listRemovedTargetLabels()
  })

  ipcMain.handle('ssh:addTarget', (_event, args: { target: SshTargetCreateInput }) =>
    mutations.add(args.target)
  )

  ipcMain.handle(
    'ssh:updateTarget',
    (_event, args: { id: string; updates: SshTargetUpdateInput }) =>
      mutations.update(args.id, args.updates)
  )

  ipcMain.handle('ssh:removeTarget', (_event, args: { id: string }) => mutations.remove(args.id))

  ipcMain.handle('ssh:importConfig', (_event, args?: { reAdopt?: boolean }) => {
    const targets = getSshTargetRegistryStore()!.importFromSshConfig(args)
    const repoReadoptions = takeSshTargetRepoReadoptions(changed)
    return { targets, repoReadoptions }
  })

  // Why: add-host dialog picks one config entry to prefill the form; does not
  // mutate the target store (bulk sync stays on Settings → Import).
  ipcMain.handle('ssh:listConfigHosts', (_event, args?: SshConfigHostListArgs) => {
    return listUserSshConfigHostSummaries(
      getSshTargetRegistryStore()!.listTargets(),
      args?.query,
      getSshTargetRegistryStore()!.listSuppressedSshConfigAliases(),
      { refresh: args?.refresh === true }
    )
  })

  ipcMain.handle('ssh:resolveConfigHost', (_event, args: { alias: string }) => {
    return resolveUserSshConfigHost(args.alias)
  })
}
