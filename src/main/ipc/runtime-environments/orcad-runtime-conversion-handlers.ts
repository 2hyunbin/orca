import { ipcMain } from 'electron'
import type {
  OrcadManagedConversionResult,
  OrcadManagedPendingMigrationRow
} from '../../../shared/orcad-managed-runtime'
import { listPendingManagedOrcadMigrations } from '../../managed-server/lifecycle/orcad-managed-migration-status'
import { ensureSshConnectionManager } from '../../ssh/targets/ssh-target-registry'
import { requiredString } from './orcad-runtime-lifecycle-handlers'

export function registerOrcadRuntimeConversionHandlers(getUserDataPath: () => string): void {
  ipcMain.handle(
    'runtimeEnvironments:convertSshHostToManagedOrcad',
    async (
      _event,
      args: { sshTargetId: string; name: string }
    ): Promise<OrcadManagedConversionResult> => {
      await ensureSshConnectionManager()
      const { convertSshTargetToManagedOrcad } =
        await import('../../managed-server/lifecycle/orcad-runtime-conversion')
      const { conversionCollaborators } =
        await import('../../managed-server/lifecycle/orcad-runtime-conversion-wiring')
      return convertSshTargetToManagedOrcad(getUserDataPath(), {
        sshTargetId: requiredString(args?.sshTargetId, 'SSH target'),
        name: requiredString(args?.name, 'Server name'),
        ...conversionCollaborators()
      })
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:listPendingOrcadMigrations',
    (): OrcadManagedPendingMigrationRow[] => listPendingManagedOrcadMigrations(getUserDataPath())
  )
}
